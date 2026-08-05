import { useState } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import { api } from "./api";

// Custom edge that exposes a ✂ button at the edge's midpoint on hover, so
// connections can be removed without keyboard / right-click. The button only
// appears near the middle of the line, so accidental hover near a node's port
// area doesn't trigger it.
export function CutEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const [hover, setHover] = useState(false);

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {/* invisible thick hit-area for easier hover */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={22}
        style={{ cursor: "pointer" }}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
      />
      <EdgeLabelRenderer>
        <div
          className={`edge-cut-wrap${hover ? " on" : ""}`}
          style={{
            position: "absolute",
            transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: "all",
          }}
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
        >
          <button
            className="edge-cut"
            title="この接続を削除"
            onClick={(e) => {
              e.stopPropagation();
              api.disconnect(id).catch((err) => alert((err as Error).message));
            }}
          >
            ✂
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
