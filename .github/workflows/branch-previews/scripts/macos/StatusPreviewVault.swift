// A login-Keychain client for the Status Page runner. Only op receives the
// bootstrap token. The browser owner receives the four approved viewer fields.
import Foundation
import Security

struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}
let vault = "Status Preview Browser"
let runner = "Status Preview Browser Runner"
let item = "Status Page preview viewer"
let key: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "dev.arusty.status.preview-browser.1password",
    kSecAttrAccount as String: runner,
]
let files = FileManager.default

func requireSuccess(_ status: OSStatus, _ action: String) throws {
    if status != errSecSuccess { throw Failure("Keychain \(action) failed (\(status)).") }
}

func storedToken() throws -> Data? {
    var query = key
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    try requireSuccess(status, "read")
    guard let data = result as? Data else { throw Failure("Invalid Keychain item.") }
    return data
}

func runOp(_ args: [String], env: [String: String]) throws -> Data {
    let process = Process()
    let path = ["/opt/homebrew/bin/op", "/usr/local/bin/op"].first(where: files.isExecutableFile)
    guard let path else { throw Failure("Install 1Password CLI first.") }
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = args
    process.environment = env
    process.standardInput = FileHandle.nullDevice
    let output = Pipe()
    process.standardOutput = output
    process.standardError = args.contains("service-account") ? FileHandle.standardError : FileHandle.nullDevice
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw Failure("1Password CLI failed (\(process.terminationStatus)). Check provisioning authorization or service-account validity.")
    }
    return data
}

let baseEnv = ProcessInfo.processInfo.environment.filter { ["HOME","PATH","TMPDIR","USER","LOGNAME","LANG"].contains($0.key) }

func provision() throws {
    if let existing = try storedToken() {
        guard existing.starts(with: Data("ops_".utf8)) else { throw Failure("An incomplete provisioning record exists. Check the account before retrying.") }
        print("The runner Keychain item already exists.")
        return
    }
    // Reserve the slot first. Only the creator proceeds if two setup jobs race.
    var reservation = key
    reservation[kSecValueData as String] = Data("provisioning".utf8)
    try requireSuccess(SecItemAdd(reservation as CFDictionary, nil), "reservation")
    var issued = false
    do {
        let output = try runOp(["--account","my.1password.com","service-account","create",runner,
                                "--vault",vault + ":read_items","--expires-in","30d","--raw"], env: baseEnv)
        issued = true
        let value = String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.hasPrefix("ops_"), !value.contains(where: { $0.isWhitespace }) else { throw Failure("Unexpected service-account token format.") }
        let update = [kSecValueData as String: Data(value.utf8)]
        try requireSuccess(SecItemUpdate(key as CFDictionary, update as CFDictionary), "save")
        guard try storedToken() == Data(value.utf8) else { throw Failure("Keychain readback failed.") }
        print("Created a 30-day read_items service account and verified its Keychain record.")
    } catch {
        if !issued { _ = SecItemDelete(key as CFDictionary) }
        else { FileHandle.standardError.write(Data("Check the newly issued service account in 1Password before retrying.\n".utf8)) }
        throw error
    }
}

func withServiceAccount(_ body: ([String], [String: String]) throws -> Void) throws {
    guard let data = try storedToken(), data.starts(with: Data("ops_".utf8)) else { throw Failure("Provision the runner Keychain item first.") }
    let directory = files.temporaryDirectory.appendingPathComponent("preview-op-" + UUID().uuidString)
    try files.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? files.removeItem(at: directory) }
    var env = baseEnv
    env["OP_SERVICE_ACCOUNT_TOKEN"] = String(decoding: data, as: UTF8.self)
    env["OP_BIOMETRIC_UNLOCK_ENABLED"] = "false"
    try body(["--config", directory.path, "--cache=false"], env)
}

func scopeCheck(_ args: [String], _ env: [String: String]) throws {
    let user = try JSONSerialization.jsonObject(with: runOp(args + ["user","get","--me","--format","json"], env: env)) as? [String: Any]
    let vaults = try JSONSerialization.jsonObject(with: runOp(args + ["vault","list","--format","json"], env: env)) as? [[String: Any]]
    guard user?["type"] as? String == "SERVICE_ACCOUNT", vaults?.compactMap({ $0["name"] as? String }) == [vault] else {
        throw Failure("Unexpected service-account identity or vault scope.")
    }
    print("Verified service-account identity and sole visible vault: " + vault + ".")
}

func viewer(_ args: [String], _ env: [String: String]) throws {
    var info = stat()
    guard fstat(STDOUT_FILENO, &info) == 0, (info.st_mode & S_IFMT) == S_IFIFO || (info.st_mode & S_IFMT) == S_IFSOCK else {
        throw Failure("Viewer values require an IPC channel to the browser owner.")
    }
    let data = try runOp(args + ["item","get",item,"--vault",vault,"--format","json"], env: env)
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let fields = object?["fields"] as? [[String: Any]] ?? []
    let keys = ["client_id":"CF_ACCESS_CLIENT_ID", "client_secret":"CF_ACCESS_CLIENT_SECRET",
                "origin":"PREVIEW_ACCESS_ORIGIN", "account_id":"BROWSER_RUN_ACCOUNT_ID"]
    var result = [String: String]()
    for field in fields {
        if let id = field["id"] as? String, let name = keys[id], let value = field["value"] as? String, !value.isEmpty {
            result[name] = value
        }
    }
    guard result.count == keys.count, result["PREVIEW_ACCESS_ORIGIN"] == "https://status.sow.foo" else {
        throw Failure("The staging viewer item failed validation.")
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
}

do {
    try requireSuccess(SecKeychainSetUserInteractionAllowed(false), "noninteractive mode")
    switch Array(CommandLine.arguments.dropFirst()) {
    case ["provision"]: try provision()
    case ["verify"]: try withServiceAccount(scopeCheck)
    case ["viewer"]: try withServiceAccount(viewer)
    default: throw Failure("Use provision, verify, or the Status Page browser launcher.")
    }
} catch {
    FileHandle.standardError.write(Data((String(describing: error) + "\n").utf8))
    exit(1)
}
