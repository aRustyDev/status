import { configure } from '../src/installation.mjs'
import { validateManifest } from '../src/manifest.mjs'
import manifest from './fixtures/status.json' with { type: 'json' }
configure('1468279539', validateManifest(manifest))
