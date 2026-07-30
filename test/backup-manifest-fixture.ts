import fs from 'node:fs'
import path from 'node:path'
import {
  BACKUP_MANIFEST_METHOD,
  BACKUP_MANIFEST_VERSION,
  backupManifestPath,
  sha256File,
} from '../lib/backup-manifest.ts'

export function writeBackupManifestFixture(
  snapshotPath: string,
  name = path.basename(snapshotPath),
): void {
  const stat = fs.lstatSync(snapshotPath)
  const manifest = {
    version: BACKUP_MANIFEST_VERSION,
    method: BACKUP_MANIFEST_METHOD,
    name,
    size: stat.size,
    sha256: sha256File(snapshotPath),
  }
  const manifestPath = backupManifestPath(snapshotPath)
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 })
  fs.chmodSync(manifestPath, 0o600)
}
