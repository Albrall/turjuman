#!/usr/bin/env node
// Packs the Cloudflare version into one file, cloudflare/_worker.js, and a zip that holds it.
// The zip is what Cloudflare Pages takes by upload; the file alone can be pasted into a Worker's editor.
//
//   npm install && npm run build
//
// The result is the same byte for byte as long as the sources are, so `npm test` can tell when it is out of date.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))

export const bundle = async () => {
  const result = await build({
    absWorkingDir: HERE,
    entryPoints: ['worker.mjs'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    charset: 'utf8',   // the Arabic of the page and the prompts stays readable in the built file
    loader: { '.html': 'text', '.png': 'base64' },
    legalComments: 'none',
    banner: { js: '// Tarjuman for Cloudflare. Built from the sources by build.mjs: change those, not this file.' },
  })
  return Buffer.from(result.outputFiles[0].contents)
}

// A zip with one deflated file, dated 1 January 2026 so that the same content always gives the same archive
export const zipOne = (name, data) => {
  const label = Buffer.from(name)
  const packed = deflateRawSync(data, { level: 9 })
  const fields = entry => {
    entry.writeUInt16LE(20, 0)                // version needed
    entry.writeUInt16LE(0x0800, 2)            // the name is UTF-8
    entry.writeUInt16LE(8, 4)                 // deflate
    entry.writeUInt16LE(0, 6)                 // 00:00:00
    entry.writeUInt16LE(((2026 - 1980) << 9) | (1 << 5) | 1, 8)
    entry.writeUInt32LE(crc32(data), 10)
    entry.writeUInt32LE(packed.length, 14)
    entry.writeUInt32LE(data.length, 18)
    entry.writeUInt16LE(label.length, 22)
    return entry
  }
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  fields(local.subarray(4))
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)                // version made by
  fields(central.subarray(6))
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)                     // entries on this disk
  end.writeUInt16LE(1, 10)                    // entries in all
  end.writeUInt32LE(central.length + label.length, 12)
  end.writeUInt32LE(local.length + label.length + packed.length, 16)
  return Buffer.concat([local, label, packed, central, label, end])
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const worker = await bundle()
  const out = join(HERE, 'cloudflare')
  await mkdir(out, { recursive: true })
  await writeFile(join(out, '_worker.js'), worker)
  await writeFile(join(out, 'tarjuman-cloudflare.zip'), zipOne('_worker.js', worker))
  console.log(`cloudflare/_worker.js  ${(worker.length / 1024).toFixed(0)} KB`)
  console.log('cloudflare/tarjuman-cloudflare.zip')
}
