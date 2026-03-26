import { useEffect, useRef, useState } from 'react'
import { getInitialUtilityDrawerTab, SWIPE_DISTANCE_PX } from './utils'
import type { UtilityDrawerTab } from './types'

export function useSandboxUtilityDrawer(args: {
  sandboxId?: string | null
  agentPresetId?: string | null
}) {
  const [isPreviewPanelOpen, setIsPreviewPanelOpen] = useState(false)
  const [utilityDrawerTab, setUtilityDrawerTab] = useState<UtilityDrawerTab>(
    getInitialUtilityDrawerTab(args.agentPresetId),
  )
  const edgeSwipeStartX = useRef<number | null>(null)
  const panelSwipeStartX = useRef<number | null>(null)

  useEffect(() => {
    setUtilityDrawerTab(getInitialUtilityDrawerTab(args.agentPresetId))
  }, [args.agentPresetId, args.sandboxId])

  function handleEdgeSwipeStart(touchX: number) {
    edgeSwipeStartX.current = touchX
  }

  function handleEdgeSwipeEnd(touchX: number) {
    const startX = edgeSwipeStartX.current
    edgeSwipeStartX.current = null

    if (startX === null) {
      return
    }

    if (startX - touchX > SWIPE_DISTANCE_PX) {
      setIsPreviewPanelOpen(true)
    }
  }

  function handlePanelSwipeStart(touchX: number) {
    panelSwipeStartX.current = touchX
  }

  function handlePanelSwipeEnd(touchX: number) {
    const startX = panelSwipeStartX.current
    panelSwipeStartX.current = null

    if (startX === null) {
      return
    }

    if (touchX - startX > SWIPE_DISTANCE_PX) {
      setIsPreviewPanelOpen(false)
    }
  }

  return {
    isPreviewPanelOpen,
    setIsPreviewPanelOpen,
    utilityDrawerTab,
    setUtilityDrawerTab,
    handleEdgeSwipeStart,
    handleEdgeSwipeEnd,
    handlePanelSwipeStart,
    handlePanelSwipeEnd,
  }
}
