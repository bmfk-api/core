import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { IconCheck, IconCopy, IconInfo, IconShield, IconWarn } from "./icons";

function Pre(props: ComponentProps<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ref.current?.innerText ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked: nothing to do */ }
  };
  return (
    <div className="code">
      <pre ref={ref} {...props} />
      <button className="code-copy" onClick={copy} aria-label="Copy code">{copied ? <IconCheck /> : <IconCopy />}</button>
    </div>
  );
}

// Links inside the docs stay in the app; anything else opens normally.
function A({ href = "", ...props }: ComponentProps<"a">) {
  if (href.startsWith("/")) return <Link to={href} {...props} />;
  if (href.startsWith("#")) return <a href={href} {...props} />;
  return <a href={href} target="_blank" rel="noreferrer" {...props} />;
}

function Table(props: ComponentProps<"table">) {
  return <div className="table-wrap"><table {...props} /></div>;
}

type CalloutKind = "note" | "warn" | "security";
const calloutIcon = { note: <IconInfo />, warn: <IconWarn />, security: <IconShield /> };

export function Callout({ kind = "note", title, children }: { kind?: CalloutKind, title?: string, children: ReactNode }) {
  return (
    <div className={`callout callout-${kind}`} role="note">
      <div className="callout-icon">{calloutIcon[kind]}</div>
      <div className="callout-body">
        {title && <div className="callout-title">{title}</div>}
        {children}
      </div>
    </div>
  );
}

export function Cards({ children }: { children: ReactNode }) {
  return <div className="cards">{children}</div>;
}

export function Card({ title, href, children }: { title: string, href: string, children: ReactNode }) {
  return (
    <Link to={href} className="card">
      <div className="card-title">{title}</div>
      <div className="card-text">{children}</div>
    </Link>
  );
}

// Blockquotes in the docs are notes.
function Blockquote({ children }: { children?: ReactNode }) {
  return <Callout kind="note">{children}</Callout>;
}

export const mdxComponents = { pre: Pre, a: A, table: Table, blockquote: Blockquote, Callout, Cards, Card };
