import { useEffect, useState } from "react";
import { labelOfPort } from "./labels";
import type { GraphNode, ModelSpec, RunInfo } from "./types";

/** Re-render every second while `active`, for a running clock. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** 83 -> "1:23", 3725 -> "1:02:05" */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function fmtClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtValue(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function CopyButton({ text, label = "コピー" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    const ok = () => {
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    };
    const write = navigator.clipboard?.writeText(text);
    if (write) write.then(ok).catch(() => {});
    else ok();
  };
  return (
    <button type="button" className="run-copy" onClick={copy}>
      {done ? "✓ コピー済み" : label}
    </button>
  );
}

const isVideoUrl = (url: string) => /\.(mp4|webm|mov)$/i.test(url);

/**
 * What the node's latest run was started with — readable while the job is
 * still going, which is the point: a video job can run for most of an hour,
 * and "what did I send?" should not have to wait for it.
 */
export function RunDetails({
  node,
  run,
  models,
}: {
  node: GraphNode;
  run: RunInfo;
  models: ModelSpec[];
}) {
  const generating = node.status === "running" || node.status === "queued";
  const now = useNow(generating);
  const [open, setOpen] = useState(generating || node.status === "failed");
  // Re-open when a new run starts on a node whose details were folded away.
  useEffect(() => {
    if (generating) setOpen(true);
  }, [generating, run.jobId]);

  const model = models.find((m) => m.id === run.model);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const elapsed = fmtElapsed(end - Date.parse(run.startedAt));
  const params = Object.entries(run.params);
  const draft = String(run.params.draft ?? "") === "on" || run.params.draft === true;

  const state = generating
    ? { cls: "running", text: node.status === "queued" ? `待機中 · ${elapsed}` : `生成中 · ${elapsed}` }
    : node.status === "failed"
      ? { cls: "failed", text: `失敗 · ${elapsed}` }
      : { cls: "done", text: `完了 · ${elapsed}` };

  return (
    <section className="inspector-section run-section" aria-label="実行内容">
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="run-summary">
          <span className="run-title">{generating ? "実行中の内容" : "前回の実行"}</span>
          <span className={`run-state run-state-${state.cls}`}>{state.text}</span>
        </summary>

        {generating ? (
          <p className="run-note">
            このジョブは開始時の内容で生成しています。下の設定を変えても実行中のジョブには影響せず、次回の実行から反映されます。
          </p>
        ) : null}
        {node.status === "failed" && node.error ? <p className="run-error">{node.error}</p> : null}

        <dl className="run-list">
          <dt>モデル</dt>
          <dd>
            <span>{model?.label || run.model}</span>
            <code>{run.model}</code>
          </dd>

          {run.prompt ? (
            <>
              <dt>
                プロンプト
                {run.promptSource === "text_in" ? <small>（接続したテキストから）</small> : null}
              </dt>
              <dd>
                <pre className="run-prompt">{run.prompt}</pre>
                <div className="run-row">
                  <span className="run-muted">{run.prompt.length.toLocaleString()} 文字</span>
                  <CopyButton text={run.prompt} />
                </div>
              </dd>
            </>
          ) : null}

          {params.length ? (
            <>
              <dt>パラメータ</dt>
              <dd className="run-params">
                {params.map(([k, v]) => (
                  <span key={k} className="run-param" title={k}>
                    <b>{k}</b> {fmtValue(v)}
                  </span>
                ))}
              </dd>
            </>
          ) : null}

          {run.inputs.length ? (
            <>
              <dt>入力</dt>
              <dd className="run-inputs">
                {run.inputs.map((i, n) => (
                  <span key={`${i.port}-${n}`} className="run-input">
                    {i.kind === "image" && i.url ? (
                      <img src={i.url} alt="" />
                    ) : i.kind === "video" && i.url && isVideoUrl(i.url) ? (
                      <video src={i.url} muted preload="metadata" />
                    ) : null}
                    <span>
                      {labelOfPort(i.port)}
                      {i.kind === "text" && i.textChars ? ` · ${i.textChars.toLocaleString()}字` : ""}
                    </span>
                  </span>
                ))}
              </dd>
            </>
          ) : null}

          {run.estimate?.note ? (
            <>
              <dt>見積り</dt>
              <dd className="run-muted">
                {run.estimate.metered ? "" : `約 $${run.estimate.amount} · `}
                {run.estimate.note}
              </dd>
            </>
          ) : null}

          <dt>開始</dt>
          <dd className="run-muted">
            {fmtClock(run.startedAt)}
            {run.finishedAt ? ` → ${fmtClock(run.finishedAt)}` : ""}
          </dd>

          {run.providerJobId || (generating && run.model.startsWith("pika/")) ? (
            <>
              <dt>Pika ジョブID</dt>
              <dd>
                {run.providerJobId ? (
                  <div className="run-row">
                    <code className="run-jobid">{run.providerJobId}</code>
                    <CopyButton text={run.providerJobId} />
                  </div>
                ) : (
                  <span className="run-muted">送信準備中（入力のアップロード中）…</span>
                )}
              </dd>
            </>
          ) : null}
        </dl>

        {draft && run.providerJobId && node.status === "succeeded" ? (
          <p className="run-note">
            これは 480p のドラフトです。動画生成ノードで「Seedance 2.5 Draft To Video」を選び、Draft Job Id に上のジョブIDを貼ると
            1080p の本番を書き出せます（7日以内・別ジョブとして課金）。
          </p>
        ) : null}
      </details>
    </section>
  );
}
