#!/usr/bin/env node
import { main } from '../.agents/skills/preview-browser/scripts/cli.mjs'
import { statusPreviewEnvironment } from '../.github/workflows/branch-previews/scripts/runner-auth.mjs'

main(process.argv.slice(2), statusPreviewEnvironment).catch(error => { console.error(error.message); process.exitCode = 1 })
