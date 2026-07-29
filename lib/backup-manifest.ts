import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const BACKUP_MANIFEST_VERSION = 1
export const BACKUP_MANIFEST_METHOD = 'sqlite-vacuum-into'

export type BackupManifest = {
  version: typeof BACKUP_MANIFEST_VERSION
  method: typeof BACKUP_MANIFEST_METHOD
  name: string
  size: number
  sha256: string
}

export function backupManifestPath(snapshotPath: string): string {
  return `${snapshotPath}.manifest.json`
}

function assertSafeName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name === '.' || name === '..') {
    throw new Error(`备份文件名异常：${JSON.stringify(name)}`)
  }
}

function assertPrivateRegularFile(filePath: string, label: string): fs.Stats {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} 必须是 regular file：${filePath}`)
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} 权限必须是 0600：${filePath}`)
  }
  return stat
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let offset = 0
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, offset)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
      offset += read
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function serializeBackupManifest(manifest: BackupManifest): string {
  return `${JSON.stringify(manifest)}\n`
}

function parseManifest(raw: string, manifestPath: string): BackupManifest {
  if (!raw.endsWith('\n') || raw.includes('\u0000') || Buffer.byteLength(raw) > 4096) {
    throw new Error(`manifest 内容异常：${manifestPath}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`manifest JSON 无法解析：${manifestPath}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`manifest 必须是 JSON object：${manifestPath}`)
  }
  const candidate = parsed as Record<string, unknown>
  if (
    Object.keys(candidate).length !== 5 ||
    candidate.version !== BACKUP_MANIFEST_VERSION ||
    candidate.method !== BACKUP_MANIFEST_METHOD ||
    typeof candidate.name !== 'string' ||
    typeof candidate.size !== 'number' ||
    !Number.isSafeInteger(candidate.size) ||
    candidate.size < 0 ||
    typeof candidate.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.sha256)
  ) {
    throw new Error(`manifest 字段或格式不符合 v${BACKUP_MANIFEST_VERSION} 契约：${manifestPath}`)
  }
  assertSafeName(candidate.name)
  const manifest: BackupManifest = {
    version: candidate.version,
    method: candidate.method,
    name: candidate.name,
    size: candidate.size,
    sha256: candidate.sha256,
  }
  if (serializeBackupManifest(manifest) !== raw) {
    throw new Error(`manifest 不是规范序列化格式：${manifestPath}`)
  }
  return manifest
}

export function readBackupManifest(manifestPath: string): BackupManifest {
  assertPrivateRegularFile(manifestPath, 'manifest')
  return parseManifest(fs.readFileSync(manifestPath, 'utf8'), manifestPath)
}

export function verifyBackupPair(
  snapshotPath: string,
  manifestPath: string = backupManifestPath(snapshotPath),
  expectedName = path.basename(snapshotPath),
): BackupManifest {
  const stat = assertPrivateRegularFile(snapshotPath, '快照')
  const manifest = readBackupManifest(manifestPath)
  if (manifest.name !== expectedName || manifest.size !== stat.size) {
    throw new Error(`manifest 与快照文件名/大小不匹配：${snapshotPath}`)
  }
  const digest = sha256File(snapshotPath)
  if (digest !== manifest.sha256) {
    throw new Error(`manifest SHA-256 与快照不匹配：${snapshotPath}`)
  }
  return manifest
}

export function isCompleteBackupPair(snapshotPath: string): boolean {
  try {
    verifyBackupPair(snapshotPath)
    return true
  } catch {
    return false
  }
}
