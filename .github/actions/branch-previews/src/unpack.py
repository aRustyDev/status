"""Extract the untrusted build artifact only on a fresh protected runner."""
import pathlib
import sys
import tarfile

archive_path, output = sys.argv[1:]
root = pathlib.Path(output)
root.mkdir(mode=0o700)
seen = set()
total = 0
with tarfile.open(archive_path, 'r|gz') as archive:
    for member in archive:
        parts = pathlib.PurePosixPath(member.name).parts
        total += member.size
        if (not parts or parts[0] not in {'workers','assets','migrations'}
                or '..' in parts or parts in seen or len(seen) >= 100_000
                or not (member.isfile() or member.isdir()) or total > 1024 ** 3):
            raise SystemExit('Invalid build artifact')
        seen.add(parts)
        archive.extract(member, root, filter='data')
if ('workers','gateway.mjs') not in seen or not (root/'migrations').is_dir():
    raise SystemExit('Incomplete build artifact')
