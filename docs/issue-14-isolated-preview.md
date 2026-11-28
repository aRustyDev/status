# Issue 14 isolated Actions preview

This branch contains a temporary fixture for the `schema/issue-14-actions-isolated` preview. It must not be merged into the feature pull request or main.

The preview Operations Worker recognizes only this branch's controller-generated selector scope. After Access validates the designated preview administrator, the isolated database receives a one-time admin grant. A verified headless viewer can initialize the synthetic Vault value and inspect the Actions editor in read-only mode; it cannot save or delete Actions. Each new commit has a fresh schema database, so the fixtures are initialized again. Existing user role changes and Vault data are not overwritten.

The Operations Worker exposes a single synthetic destination for editor and CRUD testing. Its named service binding is deliberately absent. The branch-only probe entrypoints force Actions disabled even if deployment settings drift, and the preview probe has no cron; no Action delivery is expected. Do not enter real secrets or use this preview to test execution.

Use the `preview-browser` skill from a trusted checkout with the selector and exact commit from the successful Branch previews deployment summary. Close the headless run after testing. A future change to the trusted preview controller's scope or schema-secret configuration may require this fixture to be updated.
