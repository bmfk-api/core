/* ------------------------------------------------------------------ */
/* Request builder                                                    */
/*                                                                    */
/* A modal that turns a method's `parameters` schema into a real form, */
/* sends the request and shows the raw response. Phase 1: unsigned and */
/* Bearer endpoints — schemes that need a computed signature (Payauth) */
/* take a pasted Authorization value instead.                          */
/* ------------------------------------------------------------------ */

import { ReactNode, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom";
import axios from "axios";
import { styled } from "styled-components";
import { Badge } from "ui/src/badge/Badge";
import { Box, HBox, VBox } from "ui/src/box/Box";
import Spacer from "ui/src/spacer/Spacer";
import { Typo } from "ui/src/text/Typo";
import { ITheme } from "ui/src/theme/GlobalTheme";
import { CodeBlock, SectionLabel } from "./Atoms";
import {
	allowedValues,
	arrayElement,
	blankFromChilds,
	blankValue,
	buildPayload,
	buildQuery,
	coloTypes,
	methodColors,
} from "./schema";

const ACCENT = "#ffeb3b";

export interface IRequestTarget {
	name: string;
	method: string;
	url: string;
	parameters: any;
	authorized: boolean;
	// Scheme name from the doc's `auth` block, when the endpoint needs a signature
	// this phase can't compute.
	signedScheme?: string | null;
}

interface IResponseState {
	status: number;
	statusText: string;
	body: string;
	ms: number;
	bytes: number;
	networkError?: string;
}

let placeholder = document.getElementById("request-builder-portal");
if (!placeholder) {
	placeholder = document.createElement("div");
	placeholder.id = "request-builder-portal";
	document.body.appendChild(placeholder);
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

const FieldEl = styled.input<{ theme: ITheme }>`
	width: 100%;
	box-sizing: border-box;
	padding: 9px 11px;
	border-radius: 5px;
	font-family: monospace;
	font-size: 12.5px;
	outline: none;
	color: ${({ theme }) => theme.colors.textPrimary};
	background-color: rgba(0, 0, 0, 0.3);
	border: 1px solid rgba(255, 255, 255, 0.1);
	transition: border-color 0.2s;
	&:focus {
		border-color: ${ACCENT};
	}
	&::placeholder {
		color: rgba(255, 255, 255, 0.25);
	}
`;

const AreaEl = styled.textarea<{ theme: ITheme }>`
	width: 100%;
	box-sizing: border-box;
	padding: 9px 11px;
	border-radius: 5px;
	font-family: monospace;
	font-size: 12.5px;
	line-height: 1.5;
	outline: none;
	resize: vertical;
	color: ${({ theme }) => theme.colors.textPrimary};
	background-color: rgba(0, 0, 0, 0.3);
	border: 1px solid rgba(255, 255, 255, 0.1);
	&:focus {
		border-color: ${ACCENT};
	}
`;

// Native select: the option list is drawn by the OS, so the dark colours must be
// set on the options themselves or they render black-on-black on some platforms.
const SelectEl = styled.select<{ theme: ITheme }>`
	width: 100%;
	box-sizing: border-box;
	padding: 9px 11px;
	border-radius: 5px;
	font-family: monospace;
	font-size: 12.5px;
	outline: none;
	cursor: pointer;
	color: ${({ theme }) => theme.colors.textPrimary};
	background-color: rgba(0, 0, 0, 0.3);
	border: 1px solid rgba(255, 255, 255, 0.1);
	&:focus {
		border-color: ${ACCENT};
	}
	& > option {
		background-color: #231d2b;
		color: #ffffff;
	}
`;

const ActionEl = styled.button<{ theme: ITheme; $primary?: boolean }>`
	flex: 0 0 auto;
	padding: 10px 22px;
	border-radius: 6px;
	border: 1px solid ${({ $primary }) => ($primary ? ACCENT : "rgba(255,255,255,0.14)")};
	background-color: ${({ $primary }) => ($primary ? ACCENT : "transparent")};
	color: ${({ $primary, theme }) => ($primary ? "#19141f" : theme.colors.textPrimary)};
	font-size: 13px;
	font-weight: ${({ $primary }) => ($primary ? 700 : 400)};
	cursor: pointer;
	transition:
		opacity 0.2s,
		background-color 0.2s;
	&:hover:not(:disabled) {
		opacity: 0.85;
	}
	&:disabled {
		opacity: 0.4;
		cursor: default;
	}
`;

const SmallAction = styled.button<{ theme: ITheme }>`
	flex: 0 0 auto;
	padding: 3px 9px;
	border-radius: 4px;
	border: 1px solid rgba(255, 255, 255, 0.14);
	background-color: rgba(255, 255, 255, 0.06);
	color: ${({ theme }) => theme.colors.textPrimary};
	font-size: 11px;
	cursor: pointer;
	&:hover {
		background-color: rgba(255, 255, 255, 0.14);
	}
`;

/* ------------------------------------------------------------------ */
/* Form tree                                                           */
/* ------------------------------------------------------------------ */

const FieldLabel = ({ name, node }: { name: string; node: any }) => (
	<HBox sx={{ alignItems: "center", gap: "7px", flexWrap: "wrap", minWidth: 0 }}>
		<Typo sx={{ fontFamily: "monospace", fontSize: "12.5px", color: "rgba(255,255,255,0.92)" }}>{name}</Typo>
		{!node?.optional && (
			<Box title="required" sx={{ display: "flex" }}>
				<Typo bold color="#cc4646" sx={{ fontSize: "12px" }}>
					*
				</Typo>
			</Box>
		)}
		<Typo bold sx={{ fontSize: "10.5px", fontFamily: "monospace" }} color={coloTypes[node?.type] ?? "#9e9e9e"}>
			{node?.type}
		</Typo>
		{typeof node?.details === "string" && node.details && (
			<Typo
				color="rgba(255,255,255,0.4)"
				sx={{ fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
				{node.details}
			</Typo>
		)}
	</HBox>
);

const Group = ({ children }: { children: ReactNode }) => (
	<VBox
		sx={{
			gap: "12px",
			marginTop: "8px",
			paddingLeft: "14px",
			borderLeft: "1px solid rgba(255,255,255,0.12)",
		}}>
		{children}
	</VBox>
);

const FormNode = ({
	name,
	node,
	value,
	onChange,
}: {
	name: string;
	node: any;
	value: any;
	onChange: (v: any) => void;
}) => {
	const type = node?.type;
	const enumVals = allowedValues(node);

	if (type === "object") {
		return (
			<VBox sx={{ minWidth: 0 }}>
				<FieldLabel name={name} node={node} />
				<Group>
					{Object.entries(node.childs ?? {})
						.filter(([k]) => k !== "0")
						.map(([key, child]) => (
							<FormNode
								key={key}
								name={key}
								node={child}
								value={value?.[key]}
								onChange={v => onChange({ ...(value ?? {}), [key]: v })}
							/>
						))}
				</Group>
			</VBox>
		);
	}

	if (type === "array") {
		const el = arrayElement(node);
		const items: any[] = Array.isArray(value) ? value : [];
		return (
			<VBox sx={{ minWidth: 0 }}>
				<HBox sx={{ alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
					<FieldLabel name={name} node={node} />
					<SmallAction type="button" onClick={() => onChange([...items, blankValue(el)])}>
						+ Add item
					</SmallAction>
				</HBox>
				<Group>
					{items.length === 0 && (
						<Typo color="rgba(255,255,255,0.35)" sx={{ fontSize: "11.5px", fontStyle: "italic" }}>
							empty array
						</Typo>
					)}
					{items.map((item, i) => (
						<HBox key={i} sx={{ gap: "10px", alignItems: "flex-start", minWidth: 0 }}>
							<Box sx={{ flex: "1 1 auto", minWidth: 0 }}>
								<FormNode
									name={`[${i}]`}
									node={el ?? { type: "string", optional: true }}
									value={item}
									onChange={v => {
										const next = items.slice();
										next[i] = v;
										onChange(next);
									}}
								/>
							</Box>
							<SmallAction
								type="button"
								title="Remove"
								onClick={() => onChange(items.filter((_, j) => j !== i))}>
								✕
							</SmallAction>
						</HBox>
					))}
				</Group>
			</VBox>
		);
	}

	let control: ReactNode;
	if (type === "file") {
		control = (
			<Typo color="#ff5722" sx={{ fontSize: "11.5px" }}>
				File upload is not supported in the builder yet — use the generated snippet.
			</Typo>
		);
	} else if (enumVals.length > 0) {
		control = (
			<SelectEl value={String(value ?? "")} onChange={e => onChange(e.target.value)}>
				{node?.optional && <option value="">— not set —</option>}
				{enumVals.map((v, i) => (
					<option key={i} value={String(v)}>
						{String(v)}
					</option>
				))}
			</SelectEl>
		);
	} else if (type === "boolean") {
		control = (
			<SelectEl value={value === true ? "true" : "false"} onChange={e => onChange(e.target.value === "true")}>
				<option value="false">false</option>
				<option value="true">true</option>
			</SelectEl>
		);
	} else {
		control = (
			<FieldEl
				type={type === "number" ? "number" : type === "date" ? "date" : "text"}
				value={value === undefined || value === null ? "" : String(value)}
				placeholder={typeof node?.regex === "string" && node.regex ? node.regex : type}
				onChange={e => onChange(e.target.value)}
			/>
		);
	}

	return (
		<VBox sx={{ gap: "5px", minWidth: 0 }}>
			<FieldLabel name={name} node={node} />
			{control}
		</VBox>
	);
};

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

const statusColor = (status: number) => {
	if (status === 0) return "#cc4646";
	if (status < 300) return "#6aa76a";
	if (status < 400) return "#4c9ec7";
	if (status < 500) return "#e0922f";
	return "#cc4646";
};

export const RequestBuilder = ({ target, onClose }: { target: IRequestTarget; onClose: () => void }) => {
	const childs = target.parameters ?? {};
	const hasParams = Object.keys(childs).length > 0;

	const [values, setValues] = useState<any>(() => blankFromChilds(childs));
	const [authValue, setAuthValue] = useState<string>("");
	const [busy, setBusy] = useState(false);
	const [response, setResponse] = useState<IResponseState | null>(null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const payload = useMemo(() => buildPayload(values, childs), [values, childs]);
	const isGet = target.method.toUpperCase() === "GET";
	const query = isGet ? buildQuery(payload) : "";
	const finalUrl = query ? target.url + (target.url.includes("?") ? "&" : "?") + query : target.url;

	const send = async () => {
		setBusy(true);
		setResponse(null);
		const started = performance.now();
		try {
			const res = await axios({
				url: finalUrl,
				method: target.method as any,
				headers: {
					"Content-Type": "application/json",
					...(target.authorized && authValue ? { Authorization: authValue } : {}),
				},
				data: isGet ? undefined : payload,
				// Keep the body as text so the response is shown exactly as it arrived.
				transformResponse: r => r,
				// 4xx/5xx are results to display, not exceptions.
				validateStatus: () => true,
			});
			const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
			setResponse({
				status: res.status,
				statusText: res.statusText ?? "",
				body,
				ms: Math.round(performance.now() - started),
				bytes: new Blob([body ?? ""]).size,
			});
		} catch (e: any) {
			setResponse({
				status: 0,
				statusText: "Request failed",
				body: "",
				ms: Math.round(performance.now() - started),
				bytes: 0,
				networkError: e?.message ?? "Network error",
			});
		}
		setBusy(false);
	};

	const prettyBody = (raw: string) => {
		try {
			return JSON.stringify(JSON.parse(raw), null, 2);
		} catch {
			return raw;
		}
	};

	const modal = (
		<Box
			onClick={onClose}
			sx={{
				position: "fixed",
				// createCSSFromObject drops falsy values, so these must be strings, not 0.
				top: "0",
				left: "0",
				right: "0",
				bottom: "0",
				zIndex: 100002,
				backgroundColor: "rgba(0,0,0,0.65)",
				backdropFilter: "blur(3px)",
				display: "flex",
				alignItems: "flex-start",
				justifyContent: "center",
				padding: "40px 20px",
				overflowY: "auto",
			}}>
			<VBox
				onClick={(e: any) => e.stopPropagation()}
				sx={{
					width: "100%",
					maxWidth: "920px",
					backgroundColor: "#231d2b",
					border: "1px solid rgba(255,255,255,0.1)",
					borderRadius: "10px",
					boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
					padding: "20px",
					gap: "16px",
					minWidth: 0,
				}}>
				{/* Head */}
				<HBox sx={{ alignItems: "center", gap: "10px", flexWrap: "wrap", minWidth: 0 }}>
					<Badge color={methodColors[target.method] ?? "#666"} label={target.method} />
					<Typo
						variant="medium"
						sx={{ fontSize: "14px", flex: "1 1 auto", minWidth: 0, overflowWrap: "anywhere" }}>
						{target.name}
					</Typo>
					<SmallAction type="button" onClick={onClose} title="Close (Esc)">
						✕
					</SmallAction>
				</HBox>

				<Box
					sx={{
						padding: "8px 12px",
						backgroundColor: "rgba(0,0,0,0.3)",
						borderRadius: "5px",
						border: "1px solid rgba(255,255,255,0.06)",
					}}>
					<Typo
						sx={{
							fontFamily: "monospace",
							fontSize: "11.5px",
							color: "rgba(255,255,255,0.7)",
							overflowWrap: "anywhere",
							lineHeight: "1.45",
						}}>
						{finalUrl}
					</Typo>
				</Box>

				{/* Authorization */}
				{target.authorized && (
					<VBox sx={{ minWidth: 0 }}>
						<SectionLabel color="#7a5d12">Authorization</SectionLabel>
						<Spacer size="8px" />
						{target.signedScheme && (
							<>
								<Box
									sx={{
										padding: "10px 12px",
										backgroundColor: "rgba(224,146,47,0.1)",
										border: "1px solid rgba(224,146,47,0.3)",
										borderRadius: "5px",
									}}>
									<Typo color="rgba(255,255,255,0.8)" sx={{ fontSize: "12px", lineHeight: "1.5" }}>
										This endpoint uses <b>{target.signedScheme}</b>, which needs a signature
										computed from your secret. The builder does not sign requests yet — paste a
										ready header value below, or copy the generated snippet and run it locally.
									</Typo>
								</Box>
								<Spacer size="8px" />
							</>
						)}
						<AreaEl
							rows={2}
							value={authValue}
							placeholder="Authorization header value"
							onChange={e => setAuthValue(e.target.value)}
						/>
					</VBox>
				)}

				{/* Parameters */}
				<VBox sx={{ minWidth: 0 }}>
					<SectionLabel color="#4c9ec7">{isGet ? "Query parameters" : "Request body"}</SectionLabel>
					<Spacer size="10px" />
					{hasParams ? (
						<VBox sx={{ gap: "14px", minWidth: 0 }}>
							{Object.entries(childs)
								.filter(([k]) => k !== "0")
								.map(([key, node]) => (
									<FormNode
										key={key}
										name={key}
										node={node}
										value={values?.[key]}
										onChange={v => setValues({ ...(values ?? {}), [key]: v })}
									/>
								))}
						</VBox>
					) : (
						<Typo color="rgba(255,255,255,0.45)" sx={{ fontSize: "12.5px", fontStyle: "italic" }}>
							This endpoint takes no parameters.
						</Typo>
					)}
				</VBox>

				{/* Payload preview */}
				{hasParams && !isGet && (
					<VBox sx={{ minWidth: 0 }}>
						<SectionLabel color="#9b59b6">Payload preview</SectionLabel>
						<Spacer size="8px" />
						<CodeBlock code={JSON.stringify(payload, null, 2)} wrap />
					</VBox>
				)}

				{/* Actions */}
				<HBox sx={{ gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
					<ActionEl type="button" $primary disabled={busy} onClick={send}>
						{busy ? "Sending…" : "Send request"}
					</ActionEl>
					<ActionEl type="button" disabled={busy} onClick={() => setValues(blankFromChilds(childs))}>
						Reset
					</ActionEl>
					{response && (
						<HBox sx={{ gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
							<Badge
								color={statusColor(response.status)}
								label={response.status === 0 ? "FAILED" : `${response.status} ${response.statusText}`}
							/>
							<Typo color="rgba(255,255,255,0.45)" sx={{ fontSize: "11.5px" }}>
								{response.ms} ms · {response.bytes} B
							</Typo>
						</HBox>
					)}
				</HBox>

				{/* Response */}
				{response && (
					<VBox sx={{ minWidth: 0 }}>
						<SectionLabel color="#6aa76a">Response</SectionLabel>
						<Spacer size="8px" />
						{response.networkError ? (
							<Box
								sx={{
									padding: "12px 14px",
									backgroundColor: "rgba(204,70,70,0.12)",
									border: "1px solid rgba(204,70,70,0.35)",
									borderRadius: "5px",
								}}>
								<Typo color="rgba(255,255,255,0.85)" sx={{ fontSize: "12.5px", lineHeight: "1.55" }}>
									{response.networkError}. The browser reports no status, which usually means the
									request never reached the API — most often CORS: the server has to allow this origin
									and the <b>Authorization</b> header, and answer the preflight <b>OPTIONS</b> call.
								</Typo>
							</Box>
						) : (
							<CodeBlock code={prettyBody(response.body) || "(empty body)"} wrap />
						)}
					</VBox>
				)}
			</VBox>
		</Box>
	);

	return ReactDOM.createPortal(modal, placeholder as HTMLElement);
};
