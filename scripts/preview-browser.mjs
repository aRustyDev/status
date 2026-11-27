#!/usr/bin/env node
import { main } from '../skills/preview-browser/scripts/cli.mjs'

main().catch(error => { console.error(error.message); process.exitCode = 1 })
