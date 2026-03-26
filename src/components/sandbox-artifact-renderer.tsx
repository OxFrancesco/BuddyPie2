import { type ReactNode } from 'react'
import { z } from 'zod'
import { defineCatalog } from '@json-render/core'
import type { Spec } from '@json-render/core'
import { JSONUIProvider, Renderer, defineRegistry } from '@json-render/react'
import { schema } from '@json-render/react/schema'
import type { SandboxArtifactManifestV1 } from '~/lib/artifacts'
import { shadcnComponents } from '@json-render/shadcn'
import { shadcnComponentDefinitions } from '@json-render/shadcn/catalog'

const relationGraphNodeSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  detail: z.string().trim().min(1).nullable().optional(),
  tone: z.enum(['default', 'positive', 'negative', 'warning', 'neutral']).nullable().optional(),
  size: z.number().min(1).max(3).nullable().optional(),
})

const relationGraphEdgeSchema = z.object({
  source: z.string().trim().min(1),
  target: z.string().trim().min(1),
  label: z.string().trim().min(1).nullable().optional(),
  tone: z.enum(['default', 'positive', 'negative', 'warning', 'neutral']).nullable().optional(),
  weight: z.number().min(1).max(4).nullable().optional(),
})

function getGraphToneColors(tone?: string | null) {
  switch (tone) {
    case 'positive':
      return {
        fill: '#dcfce7',
        stroke: '#16a34a',
        text: '#14532d',
      }
    case 'negative':
      return {
        fill: '#fee2e2',
        stroke: '#dc2626',
        text: '#7f1d1d',
      }
    case 'warning':
      return {
        fill: '#fef3c7',
        stroke: '#d97706',
        text: '#78350f',
      }
    case 'neutral':
      return {
        fill: '#e5e7eb',
        stroke: '#6b7280',
        text: '#111827',
      }
    default:
      return {
        fill: '#dbeafe',
        stroke: '#2563eb',
        text: '#172554',
      }
  }
}

// ── Wallet address detection & DeBank linking ──────────────────────────

const ETH_ADDRESS_RE = /0x[a-fA-F0-9]{4,40}/

function extractFullAddress(text: string): string | null {
  const clean = text.replace(/`/g, '')
  const match = clean.match(/0x[a-fA-F0-9]{40}/)
  if (match) return match[0]
  const shortMatch = clean.match(/0x[a-fA-F0-9]{4,}\.{2,3}[a-fA-F0-9]{4,}/)
  if (shortMatch) return null
  return null
}

function isWalletLike(text: string): boolean {
  return ETH_ADDRESS_RE.test(text.replace(/`/g, ''))
}

function WalletCell({ text }: { text: string }) {
  const clean = text.replace(/`/g, '')
  const fullAddress = extractFullAddress(clean)

  if (fullAddress) {
    return (
      <a
        href={`https://debank.com/profile/${fullAddress}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 font-mono text-[13px] text-chart-4 underline decoration-chart-4/30 underline-offset-2 transition-colors hover:text-chart-4/80"
      >
        {clean}
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="shrink-0 opacity-50">
          <path d="M6 3H3v10h10v-3M9 2h5v5M14 2L7 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>
    )
  }

  if (isWalletLike(clean)) {
    return (
      <span className="font-mono text-[13px] text-chart-4">{clean}</span>
    )
  }

  return <>{text}</>
}

function renderCellContent(text: string): ReactNode {
  if (isWalletLike(text)) {
    return <WalletCell text={text} />
  }

  if (text.startsWith('`') && text.endsWith('`')) {
    const inner = text.slice(1, -1)
    if (isWalletLike(inner)) {
      return <WalletCell text={inner} />
    }
    return <code className="bg-muted px-1.5 py-0.5 font-mono text-[13px]">{inner}</code>
  }

  return text
}

// ── Section accent colors (cycle per card) ─────────────────────────────

const SECTION_ACCENTS = [
  { border: 'border-l-accent', headerBg: 'bg-accent/10', label: 'text-accent-foreground' },
  { border: 'border-l-chart-4', headerBg: 'bg-chart-4/10', label: 'text-chart-4' },
  { border: 'border-l-chart-3', headerBg: 'bg-chart-3/10', label: 'text-chart-3' },
  { border: 'border-l-chart-2', headerBg: 'bg-chart-2/10', label: 'text-chart-2' },
  { border: 'border-l-chart-5', headerBg: 'bg-chart-5/10', label: 'text-chart-5' },
]

let sectionCounter = 0
function getNextSectionAccent() {
  const accent = SECTION_ACCENTS[sectionCounter % SECTION_ACCENTS.length]!
  sectionCounter++
  return accent
}

// ── Custom styled components ───────────────────────────────────────────

function ArtifactCard({ props, children }: {
  props: { title?: string | null; description?: string | null }
  children?: ReactNode
}) {
  const accent = getNextSectionAccent()

  return (
    <div className={`border-2 border-foreground ${accent.border} border-l-4 bg-card`}>
      {(props.title || props.description) && (
        <div className={`${accent.headerBg} border-b-2 border-foreground px-4 py-2.5`}>
          {props.title && (
            <p className="text-xs font-black uppercase tracking-widest">
              {props.title}
            </p>
          )}
          {props.description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{props.description}</p>
          )}
        </div>
      )}
      <div className="flex flex-col gap-0">{children}</div>
    </div>
  )
}

function ArtifactTable({ props }: {
  props: {
    columns?: string[] | null
    rows?: (string | number)[][] | null
    caption?: string | null
  }
}) {
  const columns = props.columns ?? []
  const rows = (props.rows ?? []).map((row) => row.map(String))

  const isKeyValueTable = columns.length === 2 && columns[0] === 'Field' && columns[1] === 'Value'

  if (isKeyValueTable) {
    return (
      <div className="divide-y divide-foreground/10">
        {rows.map((row, i) => (
          <div key={i} className="flex items-baseline gap-4 px-4 py-2 text-sm hover:bg-muted/40">
            <span className="w-[180px] shrink-0 text-xs font-bold uppercase tracking-wide text-muted-foreground">
              {row[0]}
            </span>
            <span className="min-w-0 font-medium">
              {renderCellContent(row[1] ?? '')}
            </span>
          </div>
        ))}
      </div>
    )
  }

  // Detect "Side" column for buy/sell coloring
  const sideColIndex = columns.findIndex(
    (col) => col.toLowerCase() === 'side',
  )

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        {props.caption && (
          <caption className="px-4 py-2 text-left text-xs text-muted-foreground">
            {props.caption}
          </caption>
        )}
        <thead>
          <tr className="border-b-2 border-foreground bg-muted/60">
            {columns.map((col) => (
              <th
                key={col}
                className="px-4 py-2 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-foreground/10">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-muted/30 transition-colors">
              {row.map((cell, j) => {
                const isSideCell = j === sideColIndex
                const isBuy = isSideCell && cell.toUpperCase() === 'BUY'
                const isSell = isSideCell && cell.toUpperCase() === 'SELL'

                return (
                  <td
                    key={j}
                    className={`px-4 py-2 text-sm ${
                      isBuy
                        ? 'font-bold text-chart-3'
                        : isSell
                          ? 'font-bold text-chart-2'
                          : ''
                    }`}
                  >
                    {renderCellContent(cell)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ArtifactAlert({ props }: {
  props: { title?: string | null; message?: string | null; type?: string | null }
}) {
  const typeStyles: Record<string, { border: string; bg: string; text: string; icon: string }> = {
    info: {
      border: 'border-chart-4',
      bg: 'bg-chart-4/10',
      text: 'text-chart-4',
      icon: 'ℹ',
    },
    success: {
      border: 'border-chart-3',
      bg: 'bg-chart-3/10',
      text: 'text-chart-3',
      icon: '✓',
    },
    warning: {
      border: 'border-accent',
      bg: 'bg-accent/15',
      text: 'text-accent-foreground',
      icon: '⚠',
    },
    error: {
      border: 'border-destructive',
      bg: 'bg-destructive/10',
      text: 'text-destructive',
      icon: '✕',
    },
  }

  const style = typeStyles[props.type ?? 'info'] ?? typeStyles.info!

  return (
    <div className={`border-2 ${style.border} ${style.bg} border-l-4 px-4 py-3`}>
      <div className="flex items-start gap-2.5">
        <span className={`${style.text} text-base font-bold leading-none mt-0.5`}>
          {style.icon}
        </span>
        <div className="min-w-0">
          <p className={`text-sm font-bold ${style.text}`}>{props.title}</p>
          {props.message && (
            <p className="mt-1 text-sm text-foreground/80">{props.message}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function ArtifactSeparator({ props }: { props: { orientation?: string | null } }) {
  if (props.orientation === 'vertical') {
    return <div className="h-full mx-2 w-px bg-foreground/15" />
  }
  return <div className="my-1" />
}

function ArtifactStack({ props, children }: {
  props: { direction?: string | null; gap?: string | null; align?: string | null; justify?: string | null }
  children?: ReactNode
}) {
  const isHorizontal = props.direction === 'horizontal'
  const gapMap: Record<string, string> = {
    none: 'gap-0',
    sm: 'gap-2',
    md: 'gap-4',
    lg: 'gap-6',
  }
  const alignMap: Record<string, string> = {
    start: 'items-start',
    center: 'items-center',
    end: 'items-end',
    stretch: 'items-stretch',
  }
  const justifyMap: Record<string, string> = {
    start: '',
    center: 'justify-center',
    end: 'justify-end',
    between: 'justify-between',
    around: 'justify-around',
  }

  const gap = gapMap[props.gap ?? 'md'] ?? 'gap-4'
  const align = alignMap[props.align ?? 'start'] ?? 'items-start'
  const justify = justifyMap[props.justify ?? ''] ?? ''

  return (
    <div className={`flex ${isHorizontal ? 'flex-row flex-wrap' : 'flex-col'} ${gap} ${align} ${justify}`}>
      {children}
    </div>
  )
}

function ArtifactText({ props }: { props: { text?: string | null; variant?: string | null } }) {
  const text = props.text ?? ''

  if (props.variant === 'code') {
    return <code className="bg-muted px-1.5 py-0.5 font-mono text-sm">{text}</code>
  }

  if (props.variant === 'muted') {
    return <p className="text-sm text-muted-foreground">{renderCellContent(text)}</p>
  }

  return <p className="text-sm">{renderCellContent(text)}</p>
}

// ── Relation Graph (unchanged) ─────────────────────────────────────────

function RelationGraph(props: {
  props: {
    title?: string | null
    description?: string | null
    nodes: Array<z.infer<typeof relationGraphNodeSchema>>
    edges: Array<z.infer<typeof relationGraphEdgeSchema>>
    center?: string | null
    height?: number | null
  }
}) {
  const height = props.props.height ?? 560
  const width = 1120
  const centerNodeId = props.props.center?.trim() || props.props.nodes[0]?.id
  const centerNode = props.props.nodes.find((node) => node.id === centerNodeId)
  const orbitNodes = props.props.nodes.filter((node) => node.id !== centerNode?.id)
  const nodePositions = new Map<
    string,
    {
      x: number
      y: number
      radius: number
    }
  >()
  const midX = width / 2
  const midY = height / 2
  const orbitRadius =
    orbitNodes.length > 0 ? Math.max(170, Math.min(360, height / 2 - 72)) : 0

  if (centerNode) {
    nodePositions.set(centerNode.id, {
      x: midX,
      y: midY,
      radius: 42 * (centerNode.size ?? 1.2),
    })
  }

  orbitNodes.forEach((node, index) => {
    const angle =
      orbitNodes.length === 1
        ? -Math.PI / 2
        : -Math.PI / 2 + (index / orbitNodes.length) * Math.PI * 2

    nodePositions.set(node.id, {
      x: midX + Math.cos(angle) * orbitRadius,
      y: midY + Math.sin(angle) * orbitRadius,
      radius: 30 * (node.size ?? 1),
    })
  })

  return (
    <div className="space-y-4">
      {props.props.title ? (
        <div>
          <p className="text-sm font-black uppercase tracking-wide">
            {props.props.title}
          </p>
          {props.props.description ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {props.props.description}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border-2 border-foreground bg-white">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full"
          role="img"
          aria-label={props.props.title ?? 'Relationship graph'}
        >
          <rect x="0" y="0" width={width} height={height} fill="#fafaf9" />

          {props.props.edges.map((edge, index) => {
            const source = nodePositions.get(edge.source)
            const target = nodePositions.get(edge.target)

            if (!source || !target) {
              return null
            }

            const tone = getGraphToneColors(edge.tone)
            const labelX = (source.x + target.x) / 2
            const labelY = (source.y + target.y) / 2

            return (
              <g key={`${edge.source}-${edge.target}-${index}`}>
                <line
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke={tone.stroke}
                  strokeWidth={edge.weight ?? 2}
                  strokeOpacity="0.7"
                />
                {edge.label ? (
                  <>
                    <rect
                      x={labelX - 68}
                      y={labelY - 16}
                      width="136"
                      height="24"
                      rx="12"
                      fill="#ffffff"
                      stroke={tone.stroke}
                      strokeWidth="1"
                    />
                    <text
                      x={labelX}
                      y={labelY}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fontSize="14"
                      fontWeight="700"
                      fill="#111827"
                    >
                      {edge.label}
                    </text>
                  </>
                ) : null}
              </g>
            )
          })}

          {props.props.nodes.map((node) => {
            const position = nodePositions.get(node.id)

            if (!position) {
              return null
            }

            const tone = getGraphToneColors(node.tone)

            return (
              <g key={node.id}>
                <circle
                  cx={position.x}
                  cy={position.y}
                  r={position.radius}
                  fill={tone.fill}
                  stroke={tone.stroke}
                  strokeWidth="3"
                />
                <text
                  x={position.x}
                  y={position.y - (node.detail ? 8 : 0)}
                  textAnchor="middle"
                  fontSize={centerNode?.id === node.id ? '18' : '15'}
                  fontWeight="800"
                  fill={tone.text}
                >
                  {node.label}
                </text>
                {node.detail ? (
                  <text
                    x={position.x}
                    y={position.y + 16}
                    textAnchor="middle"
                    fontSize="12"
                    fontWeight="600"
                    fill="#374151"
                  >
                    {node.detail}
                  </text>
                ) : null}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

const artifactCatalog = defineCatalog(schema, {
  components: {
    ...shadcnComponentDefinitions,
    RelationGraph: {
      props: z.object({
        title: z.string().trim().min(1).nullable().optional(),
        description: z.string().trim().min(1).nullable().optional(),
        nodes: z.array(relationGraphNodeSchema).min(1),
        edges: z.array(relationGraphEdgeSchema).default([]),
        center: z.string().trim().min(1).nullable().optional(),
        height: z.number().min(280).max(1200).nullable().optional(),
      }),
      description:
        'Relationship graph with nodes and labeled edges for wallets, entities, tokens, or counterparties.',
    },
  },
  actions: {},
})

const { registry } = defineRegistry(artifactCatalog, {
  components: {
    ...shadcnComponents,
    Card: ArtifactCard as any,
    Table: ArtifactTable as any,
    Alert: ArtifactAlert as any,
    Separator: ArtifactSeparator as any,
    Stack: ArtifactStack as any,
    Text: ArtifactText as any,
    RelationGraph,
  },
})

export function SandboxArtifactRenderer(props: {
  manifest: SandboxArtifactManifestV1
}) {
  // Reset section counter so colors are deterministic per render
  sectionCounter = 0

  return (
    <JSONUIProvider
      registry={registry}
      initialState={((props.manifest.spec as unknown) as Spec).state ?? {}}
    >
      <Renderer
        spec={(props.manifest.spec as unknown) as Spec}
        registry={registry}
      />
    </JSONUIProvider>
  )
}
