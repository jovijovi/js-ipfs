import { CID } from 'multiformats/cid'
import { createUnsafe } from 'multiformats/block'
import { base58btc } from 'multiformats/bases/base58'
import { CarWriter } from '@ipld/car/writer'
import { withTimeoutOption } from 'ipfs-core-utils/with-timeout-option'
import debug from 'debug'
import * as raw from 'multiformats/codecs/raw'
import * as json from 'multiformats/codecs/json'

const log = debug('ipfs:components:dag:import')

// blocks that we're OK with not inspecting for links
/** @type {number[]} */
const NO_LINKS_CODECS = [
  raw.code, // raw
  json.code // JSON
]

/**
 * @typedef {import('../../types').Preload} Preload
 * @typedef {import('ipfs-repo').IPFSRepo} IPFSRepo
 * @typedef {import('@ipld/car/api').BlockWriter} BlockWriter
 * @typedef {import('ipfs-core-types/src/utils').AbortOptions} AbortOptions
 */

/**
 * @param {Object} config
 * @param {IPFSRepo} config.repo
 * @param {Preload} config.preload
 * @param {import('ipfs-core-utils/multicodecs').Multicodecs} config.codecs
 */
export function createExport ({ repo, preload, codecs }) {
  /**
   * @type {import('ipfs-core-types/src/dag').API["export"]}
   */
  async function * dagExport (root, options = {}) {
    if (options.preload !== false) {
      preload(root)
    }

    const cid = CID.asCID(root)
    if (!cid) {
      throw new Error(`Unexpected error converting CID type: ${root}`)
    }

    log(`Exporting ${cid} as car`)
    const { writer, out } = await CarWriter.create([cid])

    // we need to write with one async channel and send the CarWriter output
    // with another to the caller, but if the write causes an error we capture
    // that and make sure it gets propagated
    /** @type {Error|null} */
    let err = null
    ;(async () => {
      try {
        await traverseWrite(
          repo,
          { signal: options.signal, timeout: options.timeout },
          cid,
          writer,
          codecs)
        writer.close()
      } catch (/** @type {any} */ e) {
        err = e
      }
    })()

    for await (const chunk of out) {
      if (err) {
        break
      }
      yield chunk
    }
    if (err) {
      throw err
    }
  }

  return withTimeoutOption(dagExport)
}

/**
 * @param {IPFSRepo} repo
 * @param {AbortOptions} options
 * @param {CID} cid
 * @param {BlockWriter} writer
 * @param {import('ipfs-core-utils/multicodecs').Multicodecs} codecs
 * @param {Set<string>} seen
 * @returns {Promise<void>}
 */
async function traverseWrite (repo, options, cid, writer, codecs, seen = new Set()) {
  const b58Cid = cid.toString(base58btc)
  if (seen.has(b58Cid)) {
    return
  }

  const block = await getBlock(repo, options, cid, codecs)

  log(`Adding block ${cid} to car`)
  await writer.put(block)
  seen.add(b58Cid)

  // recursive traversal of all links
  for (const link of block.links) {
    await traverseWrite(repo, options, link, writer, codecs, seen)
  }
}

/**
 * @param {IPFSRepo} repo
 * @param {AbortOptions} options
 * @param {CID} cid
 * @param {import('ipfs-core-utils/multicodecs').Multicodecs} codecs
 * @returns {Promise<{cid:CID, bytes:Uint8Array, links:CID[]}>}
 */
async function getBlock (repo, options, cid, codecs) {
  const bytes = await repo.blocks.get(cid, options)

  /** @type {CID[]} */
  let links = []
  const codec = await codecs.getCodec(cid.code)

  if (codec) {
    const block = createUnsafe({ bytes, cid, codec })
    links = [...block.links()].map((l) => l[1])
  } else if (!NO_LINKS_CODECS.includes(cid.code)) {
    throw new Error(`Can't decode links in block with codec 0x${cid.code.toString(16)} to form complete DAG`)
  }

  return { cid, bytes, links }
}
