import { useMemo, useState } from "react";
import { Box, HBox, VBox } from "ui/src/box/Box";
import { Typo } from "ui/src/text/Typo";
import { REQ_INVENTORY } from "../services/Metrix";
import { IInventory, IInventoryEndpoint, IInventoryHandler, IInventoryService } from "../types";
import { usePolling } from "../hooks/usePolling";
import { formatDuration } from "../lib/metrics";
import { Label } from "../components/Label";
import { TextInput } from "../components/TextInput";

const POLL_MS = 30_000;
const ACCENT = "#48BFE3";
const SUCCESS = "#56bb56";
const FAIL = "#bb5656";

const METHOD_COLORS: Record<string, string> = {
	GET: "#56cfe1",
	POST: "#5390d9",
	PUT: "#e9b61e",
	PATCH: "#e9b61e",
	DELETE: "#bb5656",
	ANY: "#8a8699",
};
const methodColor = (m: string) => METHOD_COLORS[m.toUpperCase()] ?? "#8a8699";

const Metric = ({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) => (
	<VBox sx={{ gap: "2px", minWidth: "80px" }}>
		<Label>{label}</Label>
		<Typo variant="headMedium" sx={color ? { color } : undefined}>
			{value}
		</Typo>
	</VBox>
);

const Section = ({ title, children }: { title: string; children?: React.ReactNode }) => (
	<VBox
		sx={{
			gap: "14px",
			padding: "16px",
			border: "1px solid rgba(255,255,255,.08)",
			borderRadius: "8px",
			backgroundColor: "rgba(0,0,0,.12)",
		}}>
		<Typo variant="headMedium">{title}</Typo>
		{children}
	</VBox>
);

const MethodBadge = ({ method }: { method: string }) => {
	const color = methodColor(method);
	return (
		<Box
			sx={{
				padding: "2px 6px",
				borderRadius: "4px",
				fontSize: ".66rem",
				fontWeight: 600,
				textAlign: "center",
				color,
				border: "1px solid " + color + "55",
				backgroundColor: color + "1a",
			}}>
			{method.toUpperCase()}
		</Box>
	);
};

const FlagChip = ({ label, active, color }: { label: string; active: boolean; color?: string }) => {
	if (!active) return null;
	const c = color ?? "#9a96ad";
	return (
		<Box
			sx={{
				padding: "1px 6px",
				borderRadius: "3px",
				fontSize: ".62rem",
				fontWeight: 500,
				letterSpacing: ".04em",
				textTransform: "uppercase",
				color: c,
				border: `1px solid ${c}44`,
				backgroundColor: `${c}12`,
			}}>
			{label}
		</Box>
	);
};

const ServiceRow = ({ svc }: { svc: IInventoryService }) => (
	<HBox sx={{ justifyContent: "space-between", gap: "12px", alignItems: "baseline", flexWrap: "wrap" }}>
		<VBox sx={{ gap: "2px" }}>
			<HBox sx={{ gap: "10px", alignItems: "baseline" }}>
				<Typo variant="medium" sx={{ fontFamily: "monospace" }}>
					{svc.name}
				</Typo>
				<Label sx={{ fontSize: ".66rem" }}>{svc.className}</Label>
			</HBox>
			<Label sx={{ fontSize: ".66rem" }}>
				created {new Date(svc.createdAt).toLocaleTimeString()}
				{svc.initializedAt ? ` · init ${new Date(svc.initializedAt).toLocaleTimeString()}` : ""}
				{svc.applicationReadyAt ? ` · ready ${new Date(svc.applicationReadyAt).toLocaleTimeString()}` : ""}
			</Label>
		</VBox>
		<HBox sx={{ gap: "12px", alignItems: "baseline" }}>
			{svc.uptimeSec !== null && <Label>{formatDuration(svc.uptimeSec)}</Label>}
			<Label sx={{ color: svc.initialized ? SUCCESS : FAIL }}>{svc.initialized ? "READY" : "NOT INIT"}</Label>
		</HBox>
	</HBox>
);

const HandlerRow = ({ h }: { h: IInventoryHandler }) => (
	<HBox
		sx={{
			gap: "10px",
			alignItems: "baseline",
			padding: "6px 0",
			borderBottom: "1px solid rgba(255,255,255,.05)",
			flexWrap: "wrap",
		}}>
		<HBox sx={{ gap: "4px" }}>
			{h.methods.map(m => (
				<MethodBadge key={m} method={m} />
			))}
		</HBox>
		<Box sx={{ fontFamily: "monospace", fontSize: ".78rem", opacity: 0.92, flexGrow: 1, minWidth: "160px" }}>
			{h.path}
		</Box>
		<HBox sx={{ gap: "4px", flexWrap: "wrap" }}>
			<FlagChip label="validation" active={h.hasValidationModel} color="#5390d9" />
			<FlagChip label="result" active={h.hasResultModel} color="#48BFE3" />
			<FlagChip label="stream" active={h.asStream} color="#80FFDB" />
			<FlagChip label="no-doc" active={h.ignoreInDocumentation} />
			<FlagChip label="no-log" active={h.ignoreHttpLogging} />
			<FlagChip label="no-intercept" active={h.ignoreInterceptor} />
			<FlagChip label="independent" active={h.independed} />
		</HBox>
	</HBox>
);

const EndpointCard = ({ ep, defaultOpen }: { ep: IInventoryEndpoint; defaultOpen?: boolean }) => {
	const [open, setOpen] = useState(!!defaultOpen);
	return (
		<VBox
			sx={{
				gap: open ? "12px" : "0px",
				padding: "12px 14px",
				border: "1px solid rgba(255,255,255,.06)",
				borderRadius: "6px",
				backgroundColor: "rgba(0,0,0,.15)",
			}}>
			<HBox
				onClick={() => setOpen(v => !v)}
				sx={{
					cursor: "pointer",
					justifyContent: "space-between",
					gap: "12px",
					alignItems: "baseline",
					flexWrap: "wrap",
				}}>
				<VBox sx={{ gap: "2px" }}>
					<HBox sx={{ gap: "10px", alignItems: "baseline" }}>
						<Typo variant="medium" sx={{ fontFamily: "monospace" }}>
							{ep.basePath || "/"}
						</Typo>
						<Label sx={{ fontSize: ".66rem" }}>{ep.className}</Label>
					</HBox>
					{ep.description && <Label sx={{ fontSize: ".68rem", opacity: 0.85 }}>{ep.description}</Label>}
				</VBox>
				<HBox sx={{ gap: "12px", alignItems: "baseline" }}>
					<Label>{ep.handlerCount} handler{ep.handlerCount === 1 ? "" : "s"}</Label>
					<Label sx={{ color: ep.initializedAt ? SUCCESS : FAIL }}>
						{ep.initializedAt ? "READY" : "NOT INIT"}
					</Label>
					<Box sx={{ opacity: 0.5, fontSize: ".8rem" }}>{open ? "▾" : "▸"}</Box>
				</HBox>
			</HBox>
			{open && (
				<VBox sx={{ gap: "2px" }}>
					{ep.handlers.length === 0 && <Label>No handlers</Label>}
					{ep.handlers.map(h => (
						<HandlerRow key={h.path + h.methods.join(",")} h={h} />
					))}
				</VBox>
			)}
		</VBox>
	);
};

export const Inventory = () => {
	const [data, setData] = useState<IInventory | null>(null);
	const [search, setSearch] = useState("");

	const [, getInventory] = REQ_INVENTORY.useRequest(response => {
		if (response?.error) return;
		if (response?.data) setData(response.data);
	});

	usePolling(() => getInventory(), POLL_MS);

	const filteredEndpoints = useMemo(() => {
		if (!data) return [];
		const q = search.trim().toLowerCase();
		if (!q) return data.endpoints;
		return data.endpoints
			.map(ep => {
				const epMatch =
					ep.basePath.toLowerCase().includes(q) ||
					ep.className.toLowerCase().includes(q) ||
					(ep.description ?? "").toLowerCase().includes(q);
				const filteredHandlers = ep.handlers.filter(
					h =>
						h.path.toLowerCase().includes(q) ||
						(h.description ?? "").toLowerCase().includes(q) ||
						(h.title ?? "").toLowerCase().includes(q) ||
						h.methods.some(m => m.toLowerCase().includes(q)),
				);
				if (epMatch) return ep;
				if (filteredHandlers.length) return { ...ep, handlers: filteredHandlers, handlerCount: filteredHandlers.length };
				return null;
			})
			.filter((ep): ep is IInventoryEndpoint => ep !== null);
	}, [data, search]);

	const filteredServices = useMemo(() => {
		if (!data) return [];
		const q = search.trim().toLowerCase();
		if (!q) return data.services;
		return data.services.filter(
			s => s.name.toLowerCase().includes(q) || s.className.toLowerCase().includes(q),
		);
	}, [data, search]);

	if (!data) return <Label>Loading…</Label>;

	return (
		<VBox sx={{ gap: "16px" }}>
			<Section title="Overview">
				<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
					<Metric label="Services" value={data.counts.services} color={ACCENT} />
					<Metric label="Endpoints" value={data.counts.endpoints} color={ACCENT} />
					<Metric label="Handlers" value={data.counts.totalHandlers} color={ACCENT} />
					<Metric
						label="Entrypoint"
						value={<span style={{ fontFamily: "monospace" }}>{data.entrypoint || "/"}</span>}
					/>
				</HBox>
				<TextInput
					type="search"
					value={search}
					placeholder="Filter by path, class, description or method…"
					onChange={e => setSearch(e.target.value)}
				/>
			</Section>

			<Section title={`Services (${filteredServices.length})`}>
				{filteredServices.length === 0 && <Label>No matches</Label>}
				<VBox sx={{ gap: "10px" }}>
					{filteredServices.map(s => (
						<ServiceRow key={s.className + s.name} svc={s} />
					))}
				</VBox>
			</Section>

			<Section title={`Endpoints (${filteredEndpoints.length})`}>
				{filteredEndpoints.length === 0 && <Label>No matches</Label>}
				<VBox sx={{ gap: "10px" }}>
					{filteredEndpoints.map(ep => (
						<EndpointCard key={ep.className + ep.basePath} ep={ep} defaultOpen={!!search.trim()} />
					))}
				</VBox>
			</Section>
		</VBox>
	);
};
