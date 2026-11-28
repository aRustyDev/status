#!/usr/bin/env node
import { main } from '../skills/preview-browser/scripts/cli.mjs'
import { statusPreviewEnvironment } from './preview/runner-auth.mjs'

main(process.argv.slice(2), statusPreviewEnvironment).catch(error => { console.error(error.message); process.exitCode = 1 })
