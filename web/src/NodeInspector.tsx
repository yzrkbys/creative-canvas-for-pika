import { useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { api } from "./api";
import { labelOf } from "./labels";
import type { GraphNode, ModelSpec, ParamField } from "./types";
import { useDismissibleLayer } from "./useDismissibleLayer";
import { RunDetails } from "./RunDetails";

function vendorOf(model: ModelSpec): string {
  const parts = model.id.replace(/^pika\//, "").split("/");
  return parts[0] || model.provider || "その他";
}

function modelMatches(model: ModelSpec, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [model.label, model.id, model.description, vendorOf(model)]
    .filter(Boolean)
    .some((value) => value!.toLocaleLowerCase().includes(normalized));
}

function valueFor(field: ParamField, raw: string): unknown {
  if (raw === "") return "";
  return field.type === "number" ? Number(raw) : raw;
}

function ParamControl({
  node,
  model,
  field,
}: {
  node: GraphNode;
  model: ModelSpec;
  field: ParamField;
}) {
  const id = `param-${node.id}-${field.key}`;
  const value = String(node.data.params[field.key] ?? model.defaults[field.key] ?? "");
  const update = (raw: string) => {
    api
      .updateNode(node.id, { data: { params: { [field.key]: valueFor(field, raw) } } })
      .catch(() => {});
  };
  const multiline =
    field.type === "string" &&
    (!!field.maxLength && field.maxLength > 160 || !!field.description?.includes("\n") || value.includes("\n"));

  return (
    <div className="inspector-field">
      <label htmlFor={id}>
        <span>{field.label}{field.required ? <span className="required-mark"> 必須</span> : null}</span>
        <code>{field.key}</code>
      </label>
      {field.description ? <p>{field.description}</p> : null}
      {field.type === "select" ? (
        <select id={id} value={value} onChange={(event) => update(event.target.value)}>
          {!field.options?.includes(value) && value !== "" ? (
            <option value={value}>{value}</option>
          ) : null}
          {field.options?.map((option) => (
            <option key={option} value={option}>
              {option === "" ? "（モデル既定）" : option}
            </option>
          ))}
        </select>
      ) : multiline ? (
        <textarea
          id={id}
          value={value}
          maxLength={field.maxLength}
          rows={5}
          onChange={(event) => update(event.target.value)}
        />
      ) : (
        <input
          id={id}
          type={field.type === "number" ? "number" : "text"}
          min={field.min}
          max={field.max}
          step={field.step}
          maxLength={field.maxLength}
          value={value}
          onChange={(event) => update(event.target.value)}
        />
      )}
      {field.type === "number" && (field.min !== undefined || field.max !== undefined) ? (
        <span className="inspector-range">
          {field.min !== undefined ? `最小 ${field.min}` : ""}
          {field.min !== undefined && field.max !== undefined ? " · " : ""}
          {field.max !== undefined ? `最大 ${field.max}` : ""}
        </span>
      ) : null}
    </div>
  );
}

function ModelGroup({
  vendor,
  models,
  selectedId,
  onSelect,
}: {
  vendor: string;
  models: ModelSpec[];
  selectedId: string;
  onSelect: (model: ModelSpec) => void;
}) {
  return (
    <div className="model-options" role="group" aria-label={`${vendor} のモデル`}>
      {models.map((model) => (
        <button
          key={model.id}
          className={`model-option${model.id === selectedId ? " selected" : ""}`}
          onClick={() => onSelect(model)}
          aria-pressed={model.id === selectedId}
        >
          <span className="model-option-main">
            <strong>{model.label || model.id}</strong>
            <code>{model.id}</code>
          </span>
          <span className="model-price">{model.priceHint}</span>
        </button>
      ))}
    </div>
  );
}

function ModelVendorDetails({
  vendor,
  models,
  selectedId,
  initiallyOpen,
  onSelect,
}: {
  vendor: string;
  models: ModelSpec[];
  selectedId: string;
  initiallyOpen: boolean;
  onSelect: (model: ModelSpec) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details
      className="model-group"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="model-vendor">
        <span>{vendor}</span><span>{models.length}</span>
      </summary>
      <ModelGroup
        vendor={vendor}
        models={models}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    </details>
  );
}

export function NodeInspector({
  node,
  models,
  prompt,
  setPrompt,
  onPromptFocus,
  onPromptBlur,
  onClose,
  returnFocusRef,
}: {
  node: GraphNode;
  models: ModelSpec[];
  prompt: string;
  setPrompt: Dispatch<SetStateAction<string>>;
  onPromptFocus: () => void;
  onPromptBlur: () => void;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement>;
}) {
  const [query, setQuery] = useState("");
  const layerRef = useDismissibleLayer<HTMLElement>(true, onClose, { returnFocusRef });
  const selected = models.find((model) => model.id === node.data.model);
  const filtered = useMemo(
    () => models.filter((model) => modelMatches(model, query)),
    [models, query],
  );
  const grouped = useMemo(() => {
    const map = new Map<string, ModelSpec[]>();
    for (const model of filtered) {
      const vendor = vendorOf(model);
      const group = map.get(vendor) ?? [];
      group.push(model);
      map.set(vendor, group);
    }
    return [...map.entries()]
      .map(([vendor, entries]) => ({
        vendor,
        models: entries.sort((a, b) => (a.label || a.id).localeCompare(b.label || b.id)),
      }))
      .sort((a, b) => a.vendor.localeCompare(b.vendor));
  }, [filtered]);
  const selectedVendor = selected ? vendorOf(selected) : "";
  const hasPrompt =
    node.type === "image_gen" ||
    node.type === "image_edit" ||
    node.type === "video_gen" ||
    node.type === "audio_gen" ||
    node.type === "video_to_audio" ||
    node.type === "llm_text";

  const selectModel = (model: ModelSpec) => {
    api.updateNode(node.id, { data: { model: model.id } }).catch(() => {});
  };

  return (
    <>
      <div className="inspector-backdrop" aria-hidden="true" />
      <aside
        ref={layerRef}
        className="node-inspector nodrag"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`inspector-title-${node.id}`}
        tabIndex={-1}
      >
        <header className="inspector-head">
          <div>
            <span className="inspector-eyebrow">ノード設定</span>
            <h2 id={`inspector-title-${node.id}`}>{labelOf(node.type)}</h2>
          </div>
          <button className="inspector-close" onClick={onClose} aria-label="ノード設定を閉じる">
            ×
          </button>
        </header>
        <div className="inspector-scroll">
          {node.lastRun ? <RunDetails node={node} run={node.lastRun} models={models} /> : null}

          {models.length > 0 ? (
            <section className="inspector-section" aria-labelledby={`model-heading-${node.id}`}>
              <div className="inspector-section-head">
                <div>
                  <h3 id={`model-heading-${node.id}`}>モデル</h3>
                  <p>{models.length}件から選択</p>
                </div>
              </div>
              {!selected && node.data.model ? (
                <div className="model-retired" role="alert">
                  <strong>このモデルは現在のカタログにありません</strong>
                  <code>{node.data.model}</code>
                  <p>提供終了か名称変更です。このままでは実行できないので、下の一覧から選び直してください。</p>
                </div>
              ) : null}
              {selected ? (
                <div className="selected-model">
                  <span>{selected.label || selected.id}</span>
                  <code>{selected.id}</code>
                  {selected.description ? <p>{selected.description}</p> : null}
                </div>
              ) : null}
              <input
                className="model-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="名前・ベンダー・モデルIDで検索…"
                aria-label="モデルを検索"
                data-autofocus
              />
              <div className="model-groups">
                {grouped.map((group) =>
                  query ? (
                    <section key={group.vendor} className="model-group expanded">
                      <div className="model-vendor">
                        <span>{group.vendor}</span><span>{group.models.length}</span>
                      </div>
                      <ModelGroup
                        vendor={group.vendor}
                        models={group.models}
                        selectedId={node.data.model}
                        onSelect={selectModel}
                      />
                    </section>
                  ) : (
                    <ModelVendorDetails
                      key={group.vendor}
                      vendor={group.vendor}
                      models={group.models}
                      selectedId={node.data.model}
                      initiallyOpen={group.vendor === selectedVendor}
                      onSelect={selectModel}
                    />
                  ),
                )}
                {grouped.length === 0 ? (
                  <div className="model-empty">該当するモデルはありません</div>
                ) : null}
              </div>
            </section>
          ) : null}

          {hasPrompt ? (
            <section className="inspector-section" aria-labelledby={`prompt-heading-${node.id}`}>
              <div className="inspector-section-head">
                <div>
                  <h3 id={`prompt-heading-${node.id}`}>プロンプト</h3>
                  <p>生成内容や指示を入力します</p>
                </div>
              </div>
              <textarea
                className="inspector-prompt"
                value={prompt}
                placeholder="プロンプトを入力…"
                rows={7}
                onFocus={onPromptFocus}
                onBlur={onPromptBlur}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </section>
          ) : null}

          {selected?.paramSchema.length ? (
            <section className="inspector-section" aria-labelledby={`params-heading-${node.id}`}>
              <div className="inspector-section-head">
                <div>
                  <h3 id={`params-heading-${node.id}`}>パラメータ</h3>
                  <p>{selected.paramSchema.length}項目 · モデル定義から自動表示</p>
                </div>
              </div>
              <div className="inspector-fields">
                {selected.paramSchema.map((field) => (
                  <ParamControl key={field.key} node={node} model={selected} field={field} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
        <footer className="inspector-foot">
          <span title={node.id}>ID: {node.id}</span>
          <button onClick={onClose}>完了</button>
        </footer>
      </aside>
    </>
  );
}
