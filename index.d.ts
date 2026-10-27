import ReadyResource from 'ready-resource'
import Bundle from 'bare-bundle'

/** Minimal public Core interface; Corestore and Hypercore currently ship no declarations. */
interface Hypercore {
  readonly key: Buffer
  readonly discoveryKey: Buffer
  readonly length: number
  readonly writable: boolean
  ready(): Promise<void>
  update(options?: { wait?: boolean }): Promise<boolean>
  get(index: number, options?: { wait?: boolean }): Promise<Buffer | null>
  close(): Promise<void>
}

interface BundlebeeOptions {
  key?: Uint8Array | string
  length?: number
  offline?: boolean
  autoUpdate?: boolean
  skipExistingABIs?: boolean
  peerDependencies?: string[]
  [key: string]: any
}

interface Entry {
  id: string
  source: Buffer
  resolutions: Record<string, string>
}

interface Manifest {
  abi: number
}

interface AddOptions {
  skipModules?: boolean
  peerDependencies?: string[]
  abi?: number
  dryRun?: boolean
}

interface LoadOptions {
  cache?: Record<string, any>
  skipModules?: boolean
}

interface BundleInput {
  bundle: string | Bundle
  abi?: number
}

interface ABIRecord {
  checkout: HeadInfo
  manifest: Manifest
}

interface HeadInfo {
  key: Buffer
  length: number
}

interface ReleasePin {
  format: 2
  /** Canonical z32 publisher key: the authority for name/version selection. */
  key: string
  /** Exact immutable module snapshot, before its index transaction. */
  length: number
  name: string
  version: string
  entry: string
  /** Release generation identifier, independent of host ABI. */
  abi: number
}

interface OperationOptions {
  offline?: boolean
  signal?: AbortSignal
}

type ReleaseQuery = OperationOptions & { name: string } & (
    | { version: string; abi?: never }
    | { abi: number; version?: never }
  )

interface HostRequirement {
  version: string
  abi?: string
  platform?: string
  arch?: string
}

interface HostProvider {
  exports: unknown
  version: string
  abi?: string
  platform?: string
  arch?: string
}

interface ReleaseAsset {
  path: string
  platform?: string
  arch?: string
}

interface PublishOptions {
  name: string
  version: string
  abi: number
  assets?: (string | ReleaseAsset)[]
  hostRequirements?: Record<string, HostRequirement>
  /** Bare host triplets to traverse, e.g. linux-x64 and darwin-arm64. */
  platforms?: string[]
}

interface ReleaseLoadOptions extends OperationOptions {
  assetDirectory?: string | URL
  platform?: { platform: string; arch: string }
  hostProviders?: Record<string, HostProvider>
}

interface LoadedRelease {
  exports: unknown
  readonly filename: string
  readonly id: string
}

declare class Bundlebee extends ReadyResource {
  constructor(store: any, opts?: BundlebeeOptions) // lunte-disable-line

  static validateRelease(pin: unknown): ReleasePin

  publish(root: URL, entry: string, options: PublishOptions): Promise<ReleasePin>
  resolve(query: ReleaseQuery): Promise<ReleasePin>
  prefetch(pin: ReleasePin, options?: OperationOptions): Promise<ReleasePin>
  loadRelease(pin: ReleasePin, options?: ReleaseLoadOptions): Promise<LoadedRelease>

  static require(
    store: any,
    ...args: [...files: (string | BundleInput)[], opts: BundlebeeOptions]
  ): Promise<Bundlebee>
  static require(store: any, ...files: (string | BundleInput)[]): Promise<Bundlebee>
  static bundleFrom(f: string): Bundle

  get core(): Hypercore
  get key(): Buffer
  get discoveryKey(): Buffer

  head(): HeadInfo

  get(key: string, checkout?: HeadInfo): Promise<Entry | null>
  checkout(checkout?: HeadInfo): Promise<unknown>
  manifest(checkout?: HeadInfo): Promise<Manifest | null>
  peerDependencies(checkout?: HeadInfo): Promise<Set<string> | null>

  findABI(abi: number): Promise<HeadInfo | null>
  allABIs(): AsyncIterable<ABIRecord>
  createEntryStream(checkout?: HeadInfo): AsyncIterable<Entry>

  add(root: URL, entrypoint: string, opts?: AddOptions): Promise<Bundle>
  load(root: URL, entrypoint: string, checkout?: HeadInfo, opts?: LoadOptions): Promise<any>

  close(): Promise<void>
}

declare namespace Bundlebee {
  export {
    ReleasePin,
    ReleaseQuery,
    OperationOptions,
    HostRequirement,
    HostProvider,
    ReleaseAsset,
    PublishOptions,
    ReleaseLoadOptions,
    LoadedRelease,
    BundlebeeOptions,
    HeadInfo
  }
}

export = Bundlebee
