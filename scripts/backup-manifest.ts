import path from 'node:path'
import {
  backupManifestPath,
  verifyBackupPair,
} from '../lib/backup-manifest.ts'
import { pinBackupPair } from '../lib/backup.ts'

function usage(): never {
  console.error('用法：backup-manifest.ts verify <snapshot> [manifest] [expected-name] | pin <source> <target>')
  process.exit(2)
}

const [command, first, second, third] = process.argv.slice(2)
if (!command || !first) usage()

if (command === 'verify') {
  const snapshot = path.resolve(first)
  const manifest = path.resolve(second || backupManifestPath(snapshot))
  const result = verifyBackupPair(snapshot, manifest, third || path.basename(snapshot))
  console.log(`${result.size}\t${result.sha256}`)
  process.exit(0)
}

if (command === 'pin') {
  if (!second) usage()
  const source = path.resolve(first)
  const target = path.resolve(second)
  pinBackupPair(source, target)
  process.exit(0)
}

usage()
