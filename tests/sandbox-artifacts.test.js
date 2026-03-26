import { describe, expect, test } from 'bun:test'
import {
  getSandboxArtifactManifestPath,
  parseSandboxArtifactManifest,
} from '../src/lib/artifacts.ts'

describe('sandbox artifact manifest path', () => {
  test('stores the live manifest under the sandbox-local .buddypie directory', () => {
    expect(getSandboxArtifactManifestPath('/home/daytona/example-repo')).toBe(
      '/home/daytona/example-repo/.buddypie/artifacts/current.json',
    )
  })
})

describe('parseSandboxArtifactManifest', () => {
  const manifestPath = '/home/daytona/example-repo/.buddypie/artifacts/current.json'

  test('returns empty when the manifest file is absent', () => {
    expect(
      parseSandboxArtifactManifest({
        manifestPath,
        content: null,
      }),
    ).toEqual({
      status: 'empty',
      manifestPath,
    })
  })

  test('returns invalid when the content is malformed JSON', () => {
    const result = parseSandboxArtifactManifest({
      manifestPath,
      content: '{"version":1,',
    })

    expect(result.status).toBe('invalid')
    expect(result.manifestPath).toBe(manifestPath)
    expect(result.rawContent).toBe('{"version":1,')
  })

  test('returns invalid when the JSON does not match the manifest contract', () => {
    const result = parseSandboxArtifactManifest({
      manifestPath,
      content: JSON.stringify({
        version: 1,
        kind: 'json-render',
        generatedAt: new Date().toISOString(),
        spec: {},
      }),
    })

    expect(result.status).toBe('invalid')
    expect(result.manifestPath).toBe(manifestPath)
    expect(result.error.length).toBeGreaterThan(0)
  })

  test('returns invalid when spec is not a renderable json-render tree', () => {
    const result = parseSandboxArtifactManifest({
      manifestPath,
      content: JSON.stringify({
        version: 1,
        kind: 'json-render',
        title: 'Wallet Summary',
        summary: 'A concise overview.',
        generatedAt: '2026-03-23T10:20:00.000Z',
        spec: {},
      }),
    })

    expect(result.status).toBe('invalid')
    expect(result.manifestPath).toBe(manifestPath)
    expect(result.error.length).toBeGreaterThan(0)
  })

  test('returns ready when the manifest matches the v1 contract', () => {
    const result = parseSandboxArtifactManifest({
      manifestPath,
      content: JSON.stringify({
        version: 1,
        kind: 'json-render',
        title: 'Wallet Summary',
        summary: 'A concise overview.',
        generatedAt: '2026-03-23T10:20:00.000Z',
        spec: {
          root: 'heading-1',
          elements: {
            'heading-1': {
              type: 'Heading',
              props: {
                text: 'Wallet Summary',
                level: 'h2',
              },
            },
          },
        },
      }),
    })

    expect(result).toEqual({
      status: 'ready',
      manifestPath,
      manifest: {
        version: 1,
        kind: 'json-render',
        title: 'Wallet Summary',
        summary: 'A concise overview.',
        generatedAt: '2026-03-23T10:20:00.000Z',
        spec: {
          root: 'heading-1',
          elements: {
            'heading-1': {
              type: 'Heading',
              props: {
                text: 'Wallet Summary',
                level: 'h2',
              },
              children: [],
            },
          },
        },
      },
    })
  })

  test('normalizes the simplified nansen card layout into a renderable json-render spec', () => {
    const result = parseSandboxArtifactManifest({
      manifestPath,
      content: JSON.stringify({
        version: '1',
        kind: 'json-render',
        title: 'AERO Token Movement',
        summary: 'Condensed market snapshot.',
        generatedAt: '2026-03-23T12:03:00Z',
        spec: {
          layout: 'cards',
          sections: [
            {
              type: 'card',
              title: 'Token Overview',
              fields: [
                { label: 'Name', value: 'Aerodrome' },
                { label: 'Contract', value: '0x9401...fd98631', monospace: true },
              ],
            },
            {
              type: 'card',
              title: 'Latest DEX Trades',
              table: {
                headers: ['Time', 'Trader', 'Side'],
                rows: [['12:02:37', '0x7452...574c4', 'BUY']],
              },
            },
            {
              type: 'alert',
              alert: 'info',
              title: 'Key Takeaways',
              body: 'Distribution pressure remains elevated.',
            },
          ],
        },
      }),
    })

    expect(result.status).toBe('ready')
    expect(result.manifestPath).toBe(manifestPath)

    if (result.status !== 'ready') {
      throw new Error('Expected the simplified manifest to normalize successfully.')
    }

    expect(result.manifest.version).toBe(1)
    expect(result.manifest.spec.root).toBe('artifact-root')
    expect(result.manifest.spec.elements['section-1']).toMatchObject({
      type: 'Card',
      props: {
        title: 'Token Overview',
      },
    })
    expect(result.manifest.spec.elements['section-1-fields']).toMatchObject({
      type: 'Table',
      props: {
        columns: ['Field', 'Value'],
        rows: [
          ['Name', 'Aerodrome'],
          ['Contract', '`0x9401...fd98631`'],
        ],
      },
    })
    expect(result.manifest.spec.elements['section-3']).toMatchObject({
      type: 'Alert',
      props: {
        title: 'Key Takeaways',
        message: 'Distribution pressure remains elevated.',
        type: 'info',
      },
    })
  })

  test('normalizes a simplified relation-graph section into a renderable graph element', () => {
    const result = parseSandboxArtifactManifest({
      manifestPath,
      content: JSON.stringify({
        version: '1',
        kind: 'json-render',
        title: 'AERO Relationships',
        generatedAt: '2026-03-23T12:03:00Z',
        spec: {
          layout: 'cards',
          sections: [
            {
              type: 'relation-graph',
              title: 'Wallet Cluster',
              description: 'Distribution relationships around AERO.',
              center: 'aero',
              nodes: [
                { id: 'aero', label: 'AERO', tone: 'default', size: 2 },
                { id: 'wallet-1', label: 'Token Millionaire', tone: 'negative' },
                { id: 'wallet-2', label: 'Fresh Wallets', tone: 'positive' },
              ],
              edges: [
                {
                  source: 'wallet-1',
                  target: 'aero',
                  label: 'Sold',
                  tone: 'negative',
                },
                {
                  source: 'wallet-2',
                  target: 'aero',
                  label: 'Accumulated',
                  tone: 'positive',
                },
              ],
            },
          ],
        },
      }),
    })

    expect(result.status).toBe('ready')

    if (result.status !== 'ready') {
      throw new Error('Expected the relation graph manifest to normalize successfully.')
    }

    expect(result.manifest.spec.elements['section-1']).toMatchObject({
      type: 'Card',
      props: {
        title: 'Wallet Cluster',
      },
    })
    expect(result.manifest.spec.elements['section-1-description']).toMatchObject({
      type: 'Text',
      props: {
        text: 'Distribution relationships around AERO.',
        variant: 'muted',
      },
    })
    expect(result.manifest.spec.elements['section-1-graph']).toMatchObject({
      type: 'RelationGraph',
      props: {
        center: 'aero',
        nodes: [
          { id: 'aero', label: 'AERO', tone: 'default', size: 2 },
          { id: 'wallet-1', label: 'Token Millionaire', tone: 'negative' },
          { id: 'wallet-2', label: 'Fresh Wallets', tone: 'positive' },
        ],
      },
    })
  })
})
