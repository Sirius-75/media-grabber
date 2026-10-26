export function releaseZipPath(rootDir: string, version: string): string

export function assertPackableManifest(manifest: {
  name?: string
  description?: string
  version?: string
}): void

export function zipDirectory(
  sourceDir: string,
  outFile: string,
): Promise<{ fileCount: number }>
