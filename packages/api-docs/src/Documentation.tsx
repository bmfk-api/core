import { ReactNode, useEffect, useMemo, useState } from "react";
import { IApiResponse, apiOrigin, request_doc } from "./api/Request";
import { authForm, S_LOGOUT } from "./services/Auth";
import Button from "ui/src/button/Button";
import { Badge } from "ui/src/badge/Badge";
import { VBox, HBox, Box } from "ui/src/box/Box";
import Panel from "ui/src/panel/Panel";
import Spacer from "ui/src/spacer/Spacer";
import { Typo } from "ui/src/text/Typo";
import { Error } from "ui/src/error/Error";
import Input from "ui/src/input/Input";
import { CodeBlock, SectionLabel } from "./Atoms";
import { RequestBuilder } from "./RequestBuilder";
import { allowedValues, coloTypes, isPrimitive, methodColors, sampleFromChilds, schemaChildren } from "./schema";

/* ------------------------------------------------------------------ */
/* Icons                                                              */
/* ------------------------------------------------------------------ */

const IconSearch = ({ size = "16", color = "rgba(255,255,255,0.5)" }: { size?: string; color?: string }) => (
	<svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
		<path
			d="M11.74 10.34A6 6 0 1 0 10.34 11.74L14.3 15.7a1 1 0 0 0 1.4-1.4l-3.96-3.96ZM2 6.5A4.5 4.5 0 1 1 6.5 11 4.5 4.5 0 0 1 2 6.5Z"
			fill={color}
		/>
	</svg>
);

const IconLock = ({ size = "11", color = "rgba(255,255,255,0.85)" }: { size?: string; color?: string }) => (
	<svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
		<path
			d="M12 7V5a4 4 0 1 0-8 0v2H3v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7h-1ZM6 5a2 2 0 1 1 4 0v2H6V5Z"
			fill={color}
		/>
	</svg>
);

const IconInfo = ({ size = "16", color = "#ffeb3b" }: { size?: string; color?: string }) => (
	<svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
		<path
			d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm0 14.5A6.5 6.5 0 1 1 8 1.5a6.5 6.5 0 0 1 0 13ZM7 6.8h2V12H7V6.8ZM7 3.6h2v2H7v-2Z"
			fill={color}
			fillOpacity="0.9"
		/>
	</svg>
);

const IconFile = ({ size = "18", color = "#ff5722" }: { size?: string; color?: string }) => (
	<svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
		<path
			d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6L9 1Zm0 1.6L12.4 6H9V2.6Z"
			fill={color}
			fillOpacity="0.9"
		/>
	</svg>
);

const IconChevron = ({ open, size = "12", color = "#ffeb3b" }: { open: boolean; size?: string; color?: string }) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 7 10"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		style={{
			transform: open ? "rotate(90deg)" : "rotate(0deg)",
			transition: "transform 0.2s ease",
		}}>
		<path d="M0 10H2L7 5L2 0H0L5 5L0 10Z" fill={color} fillOpacity="0.9" />
	</svg>
);

/* ------------------------------------------------------------------ */
/* Data fetching                                                      */
/* ------------------------------------------------------------------ */

export const Documentation = () => {
	const [response, setResponse] = useState<IApiResponse | null>(null);
	useEffect(() => {
		request_doc().then(resp => {
			if (resp.error) {
				console.error("Error fetching documentation:", resp.error);
			}
			setResponse(resp);
		});
	}, []);

	return (
		<Box sx={{ padding: "10px", minHeight: "100vh", boxSizing: "border-box" }}>
			{!response && (
				<HBox center sx={{ minHeight: "60vh" }}>
					<Typo variant="text" color="rgba(255,255,255,0.6)">
						Loading documentation...
					</Typo>
				</HBox>
			)}
			{response && response.error && <Error error={response.error} />}
			{response && response.data && (
				<Content
					data={response.data}
					docEndpoint={resolveDocEndpoint((response as any).endpoint)}
					version={(response as any).version}
					core={(response as any).core}
				/>
			)}
		</Box>
	);
};

/* ------------------------------------------------------------------ */
/* Search helpers                                                     */
/* ------------------------------------------------------------------ */

// Endpoint must have at least one HTTP method defined to be renderable.
const isValidEndpoint = (ep: any): boolean => !!ep && !!ep.methods && Object.keys(ep.methods).length > 0;

const endpointMatches = (ep: any, q: string): boolean => {
	if (!q) return true;
	if (ep.name?.toLowerCase().includes(q)) return true;
	for (const method in ep.methods ?? {}) {
		if (method.toLowerCase().includes(q)) return true;
		const md = ep.methods[method];
		if (typeof md?.title === "string" && md.title.toLowerCase().includes(q)) return true;
		if (typeof md?.description === "string" && md.description.toLowerCase().includes(q)) return true;
	}
	return false;
};

const filterGroups = (data: any[], q: string) => {
	return data
		.map(group => ({
			...group,
			endpoints: (group.endpoints ?? []).filter(isValidEndpoint).filter((ep: any) => endpointMatches(ep, q)),
		}))
		.filter(group => group.endpoints.length > 0 || (q && group.name?.toLowerCase().includes(q)));
};

/* ------------------------------------------------------------------ */
/* Layout                                                             */
/* ------------------------------------------------------------------ */

const Content = ({
	data,
	docEndpoint,
	version,
	core,
}: {
	data: any;
	docEndpoint?: string;
	version?: string;
	core?: string;
}) => {
	const [selected, setSelected] = useState<any>({ name: data[0].name, content: data[0] });
	const [query, setQuery] = useState<string>("");
	// `tick` bumps on every click so the same endpoint can be re-focused.
	const [focused, setFocused] = useState<{ name: string; tick: number } | null>(null);

	const q = query.trim().toLowerCase();
	const apiBase = useMemo(() => buildApiBase(docEndpoint), [docEndpoint]);

	const visibleGroups = useMemo(() => (q ? filterGroups(data, q) : [selected.content]), [data, q, selected]);

	const focusEndpoint = (group: any, endpointName: string) => {
		setSelected({ name: group.name, content: group });
		setFocused(prev => ({ name: endpointName, tick: (prev?.tick ?? 0) + 1 }));
	};

	return (
		<VBox>
			<Panel sx={{ padding: "16px 24px" }}>
				<HBox sx={{ alignItems: "center", gap: "16px" }}>
					<Typo variant="head">API Documentation</Typo>
					{version && <Badge color="#3b3357" label={"v" + version} />}
					{core && <Badge color="#2b2b3a" label={"core " + core} />}
					<Spacer grow />
					<Button onClick={() => S_LOGOUT.invoke()}>Sign out</Button>
					<Box sx={{ minWidth: "260px", maxWidth: "360px", width: "100%" }}>
						<Input
							name="search"
							type="search"
							data={{ search: "" }}
							placeholder="Search endpoints or methods..."
							iconLeft={
								<Box sx={{ display: "flex", alignItems: "center", padding: "0 0 0 14px" }}>
									<IconSearch />
								</Box>
							}
							onChange={setQuery}
						/>
					</Box>
				</HBox>
			</Panel>

			<Spacer size="10px" />

			<HBox sx={{ flexGrow: 1, alignItems: "flex-start" }}>
				<LeftPanel
					selected={selected.name}
					query={q}
					onSelect={setSelected}
					onFocusEndpoint={focusEndpoint}
					data={data}
				/>
				<Spacer size="10px" />
				<RightPanel groups={visibleGroups} apiBase={apiBase} searching={!!q} focused={focused} />
			</HBox>
		</VBox>
	);
};

const LeftPanel = ({
	data,
	onSelect,
	onFocusEndpoint,
	selected,
	query,
}: {
	selected?: string | null;
	data: any[];
	query: string;
	onSelect: (val: any) => void;
	onFocusEndpoint: (group: any, endpointName: string) => void;
}) => {
	const groups = query ? filterGroups(data, query) : data;

	return (
		<Panel
			sx={{
				padding: "0",
				minWidth: "230px",
				maxWidth: "280px",
				position: "sticky",
				top: "10px",
				alignSelf: "flex-start",
				maxHeight: "calc(100vh - 20px)",
				overflowY: "auto",
			}}>
			<VBox>
				<Spacer size="16px" />
				{groups.length === 0 && (
					<Box sx={{ padding: "16px 24px" }}>
						<Typo variant="medium" color="rgba(255,255,255,0.4)">
							Nothing found
						</Typo>
					</Box>
				)}
				{groups.map((group: any, index: number) => {
					const expanded = query ? true : selected === group.name;
					return (
						<Box key={index}>
							<Box
								onClick={() => onSelect({ name: group.name, content: group })}
								sx={{
									transition: "background-color 0.2s ease",
									padding: "8px 18px",
									cursor: "pointer",
									"&:hover": { backgroundColor: "rgba(255,255,255,0.04)" },
								}}>
								<HBox sx={{ alignItems: "center", gap: "8px" }}>
									<IconChevron open={expanded} />
									<Typo
										variant="text"
										sx={{
											textTransform: "capitalize",
											fontSize: "15px",
											fontWeight: expanded ? 600 : 400,
											color: expanded ? "#ffeb3b" : "rgba(255,255,255,0.85)",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
										}}>
										{group.name.replaceAll("/", "")}
									</Typo>
								</HBox>
							</Box>
							{expanded && group.endpoints && (
								<VBox
									sx={{
										margin: "4px 0 8px 26px",
										borderLeft: "1px dotted rgba(255,235,59,0.4)",
										paddingLeft: "8px",
									}}>
									{group.endpoints.filter(isValidEndpoint).map((ep: any, i: number) => (
										<Box
											key={i}
											onClick={() => onFocusEndpoint(group, ep.name)}
											sx={{
												padding: "5px 10px",
												borderRadius: "4px",
												cursor: "pointer",
												fontSize: "13px",
												color: "rgba(255,255,255,0.7)",
												transition: "color 0.2s ease, background-color 0.2s ease",
												"&:hover": {
													color: "rgb(236, 106, 20)",
													backgroundColor: "rgba(255,255,255,0.03)",
												},
											}}>
											{ep.name.split("/").slice(1).join("/") || ep.name}
										</Box>
									))}
								</VBox>
							)}
						</Box>
					);
				})}
			</VBox>
		</Panel>
	);
};

const AuthCaption = ({ children }: { children: any }) => (
	<Typo variant="caption" sx={{ textTransform: "uppercase", letterSpacing: "0.4px", fontSize: "10px", opacity: 0.7 }}>
		{children}
	</Typo>
);

// #784673 -> color for auth badge

const AuthOverview = ({ auth, apiBase }: { auth: AuthBlock; apiBase?: string }) => {
	const [open, setOpen] = useState<boolean>(false);
	const url = (apiBase ?? "https://<host>/api/v1/") + "<endpoint>";
	const examples = buildAuthExamples("POST", url, '{\n  "amount": 1000,\n  "currency": "EUR"\n}', true, auth);
	const fields = Object.entries(auth.fields ?? {});

	return (
		<Box
			sx={{
				backgroundColor: "rgba(0,0,0,0.18)",
				border: "1px solid rgba(255,255,255,0.07)",
				borderRadius: "8px",
				overflow: "hidden",
			}}>
			<HBox
				onClick={() => setOpen(!open)}
				sx={{
					alignItems: "center",
					gap: "12px",
					padding: "18px 22px",
					cursor: "pointer",
					transition: "background-color 0.2s ease",
					"&:hover": { backgroundColor: "rgba(0,0,0,0.25)" },
				}}>
				<IconChevron open={open} color="rgba(255,255,255,0.6)" />
				<Typo
					color="rgba(255,255,255,0.96)"
					sx={{ fontSize: "19px", fontWeight: 600, lineHeight: "1.3", letterSpacing: "0.2px" }}>
					Authorization
				</Typo>
			</HBox>
			{open && (
				<Box sx={{ padding: "4px 22px 22px 22px" }}>
					<VBox gap="18px">
						<HBox sx={{ alignItems: "center", gap: "8px" }}>
							<IconLock size="14" color="#ffeb3b" />
							<Badge color="#7a5d12" label={auth.scheme} sx={{ padding: "3px 10px" }} />
							{auth.algorithm && (
								<Badge color="#3b3357" label={auth.algorithm} sx={{ padding: "3px 10px" }} />
							)}
						</HBox>

						{auth.lines && auth.lines.length > 0 && (
							<VBox gap="10px">
								{auth.lines.map((line, i) => (
									<RichText key={i}>{line}</RichText>
								))}
							</VBox>
						)}

						{auth.steps && auth.steps.length > 0 && (
							<VBox gap="10px">
								<AuthCaption>Steps</AuthCaption>
								{auth.steps.map((step, i) => (
									<HBox key={i} sx={{ gap: "12px", alignItems: "baseline" }}>
										<Box
											sx={{
												flex: "0 0 auto",
												width: "22px",
												height: "22px",
												borderRadius: "50%",
												backgroundColor: "rgba(255,255,255,0.08)",
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
											}}>
											<Typo
												color="rgba(255,255,255,0.75)"
												sx={{ fontSize: "11px", fontWeight: 700 }}>
												{i + 1}
											</Typo>
										</Box>
										<Typo
											variant="medium"
											color="rgba(255,255,255,0.82)"
											sx={{ fontSize: "0.95rem", lineHeight: "1.55" }}>
											{step}
										</Typo>
									</HBox>
								))}
							</VBox>
						)}

						{fields.length > 0 && (
							<VBox gap="8px">
								<AuthCaption>Header fields</AuthCaption>
								{fields.map(([key, f]) => (
									<HBox key={key} sx={{ gap: "12px", alignItems: "baseline" }}>
										<Typo
											color="#4c9ec7"
											sx={{
												fontFamily: "monospace",
												fontSize: "12px",
												minWidth: "66px",
												flex: "0 0 auto",
											}}>
											{f.placeholder ?? key}
										</Typo>
										<Typo
											variant="medium"
											color="rgba(255,255,255,0.7)"
											sx={{ fontSize: "13px", lineHeight: "1.5" }}>
											{f.details}
										</Typo>
									</HBox>
								))}
							</VBox>
						)}

						<VBox gap="8px">
							<AuthCaption>Build the authorization request</AuthCaption>
							<RightTabs
								tabs={[
									{ title: "cURL", content: <CodeBlock code={examples.curl} /> },
									{ title: "JavaScript", content: <CodeBlock code={examples.js} /> },
									{ title: "PHP", content: <CodeBlock code={examples.php} /> },
								]}
							/>
						</VBox>
					</VBox>
				</Box>
			)}
		</Box>
	);
};

const GroupOverview = ({
	description,
	auth,
	apiBase,
}: {
	description?: string;
	auth: AuthBlock | null;
	apiBase?: string;
}) => {
	const [open, setOpen] = useState<boolean>(true);

	return (
		<Box
			sx={{
				backgroundColor: "rgba(0,0,0,0.18)",
				border: "1px solid rgba(255,255,255,0.06)",
				borderRadius: "8px",
				overflow: "hidden",
			}}>
			<HBox
				onClick={() => setOpen(!open)}
				sx={{
					alignItems: "center",
					gap: "10px",
					padding: "13px 16px",
					cursor: "pointer",
					transition: "background-color 0.2s ease",
					"&:hover": { backgroundColor: "rgba(0,0,0,0.25)" },
				}}>
				<IconInfo />
				<Typo
					variant="medium"
					bold
					color="rgba(255,255,255,0.85)"
					sx={{ textTransform: "uppercase", letterSpacing: "0.5px", fontSize: "12px" }}>
					Overview
				</Typo>
				<Spacer grow />
				<IconChevron open={open} />
			</HBox>
			{open && (
				<Box sx={{ padding: "6px 18px 20px 18px" }}>
					<VBox gap="18px">
						{description && <ParsedDescription description={description} />}
						{auth && <AuthOverview auth={auth} apiBase={apiBase} />}
					</VBox>
				</Box>
			)}
		</Box>
	);
};

const RightPanel = ({
	groups,
	apiBase,
	searching,
	focused,
}: {
	groups: any[];
	apiBase: string;
	searching: boolean;
	focused: { name: string; tick: number } | null;
}) => {
	return (
		<Panel sx={{ flexGrow: 1, minWidth: 0 }}>
			<VBox gap="10px">
				{groups.map((group: any, index: number) => {
					const auth = extractAuth(group.description);
					return (
						<VBox key={index} gap="12px">
							<Typo variant="head" color="#ffeb3b" sx={{ textTransform: "capitalize" }}>
								{group.name.replaceAll("/", "")}
							</Typo>
							{!searching && (group.description || auth) && (
								<GroupOverview description={group.description} auth={auth} apiBase={apiBase} />
							)}
							<VBox>
								{group.endpoints
									?.filter(isValidEndpoint)
									.map((ep: any, i: number) => (
										<Endpoint
											key={i}
											data={ep}
											apiBase={apiBase}
											defaultOpen={searching}
											auth={auth}
											focused={focused}
										/>
									))}
							</VBox>
						</VBox>
					);
				})}
			</VBox>
		</Panel>
	);
};

const Endpoint = ({
	data,
	apiBase,
	defaultOpen,
	auth,
	focused,
}: {
	data: any;
	apiBase: string;
	defaultOpen?: boolean;
	auth: AuthBlock | null;
	focused?: { name: string; tick: number } | null;
}) => {
	const [open, setOpen] = useState<boolean>(defaultOpen ?? true);
	const [active, setActive] = useState<number>(0);
	const methods = Object.keys(data.methods ?? {});
	const multi = methods.length > 1;

	// When this endpoint gets focused from the left nav — expand + smooth-scroll to center.
	useEffect(() => {
		if (!focused || focused.name !== data.name) return;
		setOpen(true);
		requestAnimationFrame(() => {
			const el = document.getElementById("link-" + data.name.replaceAll("/", "-"));
			el?.scrollIntoView({ behavior: "smooth", block: "center" });
		});
	}, [focused, data.name]);
	const activeMethod = methods[active] ?? methods[0];

	const selectMethod = (e: any, index: number) => {
		e?.stopPropagation?.();
		setActive(index);
		setOpen(true);
	};

	return (
		<VBox
			sx={{
				borderBottom: "1px solid rgba(255,255,255,0.08)",
				paddingTop: "16px",
				paddingBottom: "16px",
			}}>
			<HBox
				id={"link-" + data.name.replaceAll("/", "-")}
				onClick={() => setOpen(!open)}
				sx={{
					alignItems: "center",
					gap: "12px",
					backgroundColor: "rgba(255,255,255,0.06)",
					padding: "12px 18px",
					borderRadius: "6px",
					cursor: "pointer",
					transition: "background-color 0.2s ease",
					"&:hover": { backgroundColor: "rgba(255,255,255,0.1)" },
				}}>
				<IconChevron open={open} />
				<Typo variant="headMedium" color="#eaf6d7" sx={{ fontFamily: "monospace", fontSize: "15px" }}>
					{data.name}
				</Typo>
				<Spacer grow />
				<HBox sx={{ gap: "6px", alignItems: "center" }}>
					{methods.map((m: string, i: number) => {
						// Несколько методов — бейджи работают как переключатель
						const isActive = !multi || i === active;
						return (
							<Box
								key={m}
								onClick={multi && open ? (e: any) => selectMethod(e, i) : undefined}
								sx={{
									cursor: multi && open ? "pointer" : "inherit",
									opacity: open && multi && !isActive ? 0.4 : 1,
									transition: "opacity 0.2s ease, transform 0.1s ease",
									"&:hover": multi && open ? { transform: "translateY(-1px)" } : undefined,
								}}>
								<Badge color={methodColors[m] ?? "#666"} label={m} sx={{ padding: "4px 10px" }} />
							</Box>
						);
					})}
				</HBox>
			</HBox>

			{open && (
				<>
					<Spacer size="16px" />
					{methods.length === 0 || !activeMethod || !data.methods[activeMethod] ? (
						<Typo
							variant="medium"
							color="rgba(255,255,255,0.4)"
							sx={{ fontSize: "13px", fontStyle: "italic", paddingLeft: "2px" }}>
							No methods defined for this endpoint.
						</Typo>
					) : (
						<>
							{multi && (
								<Typo
									variant="caption"
									color="rgba(255,255,255,0.4)"
									sx={{ fontSize: "11px", paddingLeft: "2px" }}>
									Click a method above to switch
								</Typo>
							)}
							{multi && <Spacer size="8px" />}
							<Method
								key={activeMethod}
								endpointName={data.name}
								method={activeMethod}
								data={data.methods[activeMethod]}
								apiBase={apiBase}
								auth={auth}
							/>
						</>
					)}
				</>
			)}
		</VBox>
	);
};

const Method = ({
	endpointName,
	method,
	data,
	apiBase,
	auth,
}: {
	endpointName: string;
	method: string;
	data: any;
	apiBase: string;
	auth: AuthBlock | null;
}) => {
	const url = apiBase + endpointName;
	const hasParams = data.parameters && Object.keys(data.parameters).length > 0;
	const [tryOpen, setTryOpen] = useState(false);

	const examples = useMemo(
		() => buildExamples(method, url, data.parameters, !!data.authorized, auth),
		[method, url, data.parameters, data.authorized, auth],
	);

	const rightTabs = (
		<RightTabs
			tabs={[
				{ title: "Response", content: <ResponseObject returns={data.returns} /> },
				{ title: "cURL", content: <CodeBlock code={examples.curl} /> },
				{ title: "JavaScript", content: <CodeBlock code={examples.js} /> },
				{ title: "PHP", content: <CodeBlock code={examples.php} /> },
			]}
		/>
	);

	// A "file" return model means the endpoint streams a file — drop the examples
	// and response schema entirely and show a single note instead.
	const isFileResult = typeof data.returns === "string" && data.returns.toLowerCase() === "file";

	const responseSection = isFileResult ? (
		<VBox sx={{ minWidth: 0 }}>
			<SectionLabel color="#ff5722">Response</SectionLabel>
			<Spacer size="8px" />
			<HBox
				sx={{
					alignItems: "center",
					gap: "10px",
					padding: "14px 16px",
					backgroundColor: "rgba(0,0,0,0.2)",
					border: "1px solid rgba(255,255,255,0.06)",
					borderRadius: "6px",
				}}>
				<IconFile />
				<Typo variant="medium" color="rgba(255,255,255,0.85)" sx={{ fontSize: "14px" }}>
					The request returns a file (binary download).
				</Typo>
			</HBox>
		</VBox>
	) : (
		<VBox sx={{ minWidth: 0 }}>
			<SectionLabel color="#6aa76a">Response &amp; examples</SectionLabel>
			<Spacer size="8px" />
			{rightTabs}
		</VBox>
	);

	return (
		<VBox sx={{ paddingBottom: "12px" }}>
			<HBox sx={{ alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
				<Badge color={methodColors[method] ?? "#666"} label={method} />
				{data.authorized && (
					<HBox
						center
						sx={{
							backgroundColor: "#7a5d12",
							padding: "6px 16px",
							borderRadius: "20px",
							gap: "7px",
						}}>
						<Box sx={{ display: "flex" }}>
							<IconLock />
						</Box>
						<Typo
							sx={{ textTransform: "capitalize", fontSize: "10px" }}
							variant="medium"
							color="rgba(255,255,255,1)">
							Authorization required
						</Typo>
					</HBox>
				)}
				<Box
					title={url}
					sx={{
						flex: "1 1 auto",
						minWidth: "200px",
						padding: "6px 12px",
						backgroundColor: "rgba(0,0,0,0.25)",
						border: "1px solid rgba(255,255,255,0.06)",
						borderRadius: "5px",
					}}>
					<Typo
						sx={{
							fontFamily: "monospace",
							fontSize: "12px",
							color: "rgba(255,255,255,0.7)",
							overflowWrap: "anywhere",
							lineHeight: "1.4",
						}}>
						{url}
					</Typo>
				</Box>
				<Box
					onClick={() => setTryOpen(true)}
					title="Open the request builder"
					sx={{
						flex: "0 0 auto",
						padding: "6px 14px",
						borderRadius: "20px",
						cursor: "pointer",
						border: "1px solid rgba(255,235,59,0.35)",
						backgroundColor: "rgba(255,235,59,0.1)",
						transition: "background-color 0.2s ease",
						"&:hover": { backgroundColor: "rgba(255,235,59,0.2)" },
					}}>
					<Typo
						variant="medium"
						color="rgba(255,235,59,0.92)"
						sx={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
						Try it
					</Typo>
				</Box>
			</HBox>

			{tryOpen && (
				<RequestBuilder
					target={{
						name: endpointName,
						method,
						url,
						parameters: data.parameters,
						authorized: !!data.authorized,
						signedScheme: data.authorized && auth ? (auth.scheme ?? "signed auth") : null,
					}}
					onClose={() => setTryOpen(false)}
				/>
			)}

			{(data.title || data.description) && (
				<>
					<Spacer size="12px" />
					<Box sx={{ backgroundColor: "rgba(0,0,0,0.22)", padding: "12px 16px", borderRadius: "6px" }}>
						{data.title && <Typo variant="text">{data.title}</Typo>}
						{data.title && data.description && <Spacer size="6px" />}
						{data.description && <ParsedDescription description={data.description} />}
					</Box>
				</>
			)}

			<Spacer size="16px" />

			{hasParams ? (
				<Box
					sx={{
						display: "grid",
						gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
						gap: "24px",
						alignItems: "start",
					}}>
					<VBox>
						<SectionLabel color="#4c9ec7">Request parameters</SectionLabel>
						<Spacer size="8px" />
						<SchemaTree schema={data.parameters} />
					</VBox>
					{responseSection}
				</Box>
			) : (
				responseSection
			)}
		</VBox>
	);
};

const RightTabs = ({ tabs }: { tabs: { title: string; content: ReactNode }[] }) => {
	const [selected, setSelected] = useState(0);

	return (
		<VBox>
			<HBox sx={{ gap: "2px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
				{tabs.map((tab, i) => (
					<Box
						key={i}
						onClick={() => setSelected(i)}
						sx={{
							padding: "8px 14px",
							cursor: "pointer",
							marginBottom: "-1px",
							borderBottom: selected === i ? "2px solid #ffeb3b" : "2px solid transparent",
							transition: "border-bottom 0.2s ease, color 0.2s ease",
						}}>
						<Typo
							variant="medium"
							sx={{ fontSize: "13px", fontWeight: selected === i ? 600 : 400, whiteSpace: "nowrap" }}
							color={selected === i ? "#ffeb3b" : "rgba(255,255,255,0.5)"}>
							{tab.title}
						</Typo>
					</Box>
				))}
			</HBox>
			<Spacer size="14px" />
			{tabs[selected].content}
		</VBox>
	);
};

const ResponseObject = ({ returns }: { returns: any }) => {
	// A string return model (e.g. "file") means the endpoint returns raw content,
	// not the {data, error} JSON envelope — show a short note instead of a tree.
	if (typeof returns === "string") {
		const isFile = returns.toLowerCase() === "file";
		return (
			<HBox
				sx={{
					alignItems: "center",
					gap: "10px",
					padding: "14px 16px",
					backgroundColor: "rgba(0,0,0,0.2)",
					border: "1px solid rgba(255,255,255,0.06)",
					borderRadius: "6px",
				}}>
				<IconFile />
				<Typo variant="medium" color="rgba(255,255,255,0.85)" sx={{ fontSize: "14px" }}>
					{isFile ? "The endpoint returns a file (binary download)." : `Returns: ${returns}`}
				</Typo>
			</HBox>
		);
	}

	return (
		<SchemaTree
			schema={{
				data: {
					type: "object",
					optional: true,
					details: "Data object, will be null if error occurs",
					childs: returns,
				},
				error: {
					type: "object",
					optional: true,
					details: "Error object, will be null if request is successful",
					childs: {
						code: { type: "number", optional: false, details: "Error code, 0 if no error" },
						message: { type: "string", optional: false, details: "Error message, empty if no error" },
						details: { type: "string", optional: true, details: "Additional error details, can be empty" },
					},
				},
			}}
		/>
	);
};

/* ------------------------------------------------------------------ */
/* Code examples                                                      */
/* ------------------------------------------------------------------ */

interface AuthField {
	source?: "credential" | "timestamp" | "random" | "signature";
	unit?: "ms" | "s";
	length?: number;
	placeholder?: string;
	const?: string;
	details?: string;
}

interface AuthBlock {
	scheme: string;
	header: string;
	algorithm: string;
	format: string;
	signature: { base: string; encoding: "hex" | "base64"; bodyHash?: string };
	fields: Record<string, AuthField>;
	body?: { wrap?: string; field?: string; placeholder?: string; details?: string };
	steps?: string[];
	lines?: string[];
}

// auth-блок лежит в корне распарсенного group.description (рядом с lines)
const extractAuth = (description?: string): AuthBlock | null => {
	if (!description || typeof description !== "string" || !description.trim().startsWith("{")) return null;
	try {
		const parsed = JSON.parse(description);
		return parsed && typeof parsed.auth === "object" && parsed.auth ? (parsed.auth as AuthBlock) : null;
	} catch {
		return null;
	}
};

// "HMAC-SHA256" -> "sha256"
const hmacHashName = (algorithm: string): string =>
	algorithm
		.toLowerCase()
		.replace("hmac", "")
		.replace(/[^a-z0-9]/g, "");

// Pick the actual doc endpoint with the same priority as request_doc:
// 1) host pasted in the login form (full URL), 2) injected __host, 3) endpoint from the response payload.
const resolveDocEndpoint = (fromResponse?: string): string => {
	const pasted = authForm.host?.trim();
	if (pasted) return pasted;
	const injected = (window as any).__host as string | undefined;
	if (injected && injected.trim() && !/\{\{\w+\}\}/.test(injected)) return injected.trim();
	return fromResponse ?? "/api/v1/doc/json";
};

const buildApiBase = (docEndpoint?: string): string => {
	const ep = docEndpoint || "/api/v1/doc/json";
	// Strip trailing "doc/json[/]" to get the API base. Works for both absolute URLs
	// ("https://host/api/v2/doc/json") and paths ("/api/v2/doc/json").
	let base = ep.replace(/doc\/json\/?$/, "");
	if (!base.endsWith("/")) base += "/";

	// Already absolute? Use verbatim.
	if (/^https?:\/\//i.test(base)) return base;

	if (!base.startsWith("/")) base = "/" + base;
	return apiOrigin().replace(/\/$/, "") + base;
};

const buildExamples = (method: string, url: string, parameters: any, authorized: boolean, auth: AuthBlock | null) => {
	const hasBody = method !== "GET" && parameters && Object.keys(parameters).length > 0;
	const payloadJson = hasBody ? JSON.stringify(sampleFromChilds(parameters), null, 2) : "";

	if (authorized && auth) return buildAuthExamples(method, url, payloadJson, hasBody, auth);
	return buildSimpleExamples(method, url, payloadJson, hasBody, authorized);
};

// Fallback: нет описанной схемы авторизации — простой Bearer-плейсхолдер
const buildSimpleExamples = (method: string, url: string, body: string, hasBody: boolean, authorized: boolean) => {
	const curlLines = [`curl -X ${method} '${url}'`, `  -H 'Content-Type: application/json'`];
	if (authorized) curlLines.push(`  -H 'Authorization: Bearer <YOUR_TOKEN>'`);
	if (hasBody) curlLines.push(`  -d '${body.replace(/'/g, "'\\''")}'`);
	const curl = curlLines.join(" \\\n");

	const jsHeaders = ['    "Content-Type": "application/json",'];
	if (authorized) jsHeaders.push('    "Authorization": "Bearer <YOUR_TOKEN>",');
	const js = [
		`const res = await fetch("${url}", {`,
		`  method: "${method}",`,
		`  headers: {`,
		jsHeaders.join("\n"),
		`  },`,
		hasBody ? `  body: JSON.stringify(${indent(body, "  ")}),` : null,
		`});`,
		`const data = await res.json();`,
	]
		.filter(Boolean)
		.join("\n");

	const phpHeaders = ['    "Content-Type: application/json",'];
	if (authorized) phpHeaders.push('    "Authorization: Bearer <YOUR_TOKEN>",');
	const phpLines = [
		`$ch = curl_init("${url}");`,
		`curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);`,
		`curl_setopt($ch, CURLOPT_CUSTOMREQUEST, "${method}");`,
		`curl_setopt($ch, CURLOPT_HTTPHEADER, [`,
		phpHeaders.join("\n"),
		`]);`,
	];
	if (hasBody) phpLines.push(`curl_setopt($ch, CURLOPT_POSTFIELDS, '${body.replace(/'/g, "\\'")}');`);
	phpLines.push(`$response = curl_exec($ch);`, `curl_close($ch);`);
	const php = phpLines.join("\n");

	return { curl, js, php };
};

// Генерация по описанному auth-блоку: реальная сборка подписи и заголовка по плейсхолдерам
const buildAuthExamples = (method: string, url: string, payloadJson: string, hasBody: boolean, auth: AuthBlock) => {
	const fieldEntries = Object.entries(auth.fields ?? {});
	const wrapField = auth.body?.field ?? "b64";
	const hash = hmacHashName(auth.algorithm);
	const enc = auth.signature.encoding === "base64" ? "base64" : "hex";

	const payload = payloadJson && payloadJson.trim() ? payloadJson : "{}";
	const compact = (() => {
		try {
			return JSON.stringify(JSON.parse(payload));
		} catch {
			return payload;
		}
	})();

	// Map each placeholder (<KID>, <B64>, ...) to the variable that holds its value.
	const ph: Record<string, string> = {};
	for (const [k, f] of fieldEntries) if (f.placeholder) ph[f.placeholder] = k;
	if (auth.body?.placeholder) ph[auth.body.placeholder] = wrapField;
	const fill = (tpl: string, ref: (v: string) => string) =>
		Object.keys(ph)
			.sort((a, b) => b.length - a.length)
			.reduce((s, p) => s.split(p).join(ref(ph[p])), tpl);

	const sigKey = fieldEntries.find(([, f]) => f.source === "signature")?.[0] ?? "sig";

	/* ---------- cURL: заголовок из format (плейсхолдеры) + steps в комментарии ---------- */
	const steps = auth.steps ?? [];
	const curlComment = steps.length
		? ["# Build the Authorization header:", ...steps.map((s, i) => `#  ${i + 1}. ${s}`)]
		: [];
	const curlReq = [
		`curl -X ${method} '${url}'`,
		`  -H 'Content-Type: application/json'`,
		`  -H '${auth.header}: ${auth.format}'`,
	];
	if (hasBody) curlReq.push(`  -d '{"${wrapField}":"${auth.body?.placeholder ?? "<B64>"}"}'`);
	const curl = (curlComment.length ? curlComment.join("\n") + "\n\n" : "") + curlReq.join(" \\\n");

	/* ---------- JavaScript (Node crypto) ---------- */
	const jsRef = (v: string) => "${" + v + "}";
	const js: string[] = [`import crypto from "crypto";`, ``, `const SECRET = "<SECRET>";`];
	for (const [k, f] of fieldEntries) {
		if (f.source === "signature") continue;
		if (f.const !== undefined) js.push(`const ${k} = "${f.const}";`);
		else if (f.source === "timestamp")
			js.push(`const ${k} = ${f.unit === "s" ? "Math.floor(Date.now() / 1000)" : "Date.now()"};`);
		else if (f.source === "random")
			js.push(`const ${k} = crypto.randomBytes(${Math.ceil((f.length ?? 16) / 2)}).toString("hex");`);
		else js.push(`const ${k} = "${f.placeholder ?? "<" + k.toUpperCase() + ">"}";`);
	}
	js.push(``);
	js.push("const payload = " + payload + ";");
	js.push(`const ${wrapField} = Buffer.from(JSON.stringify(payload)).toString("base64");`);
	js.push(``);
	js.push("const base = `" + fill(auth.signature.base, jsRef) + "`;");
	js.push(`const ${sigKey} = crypto.createHmac("${hash}", SECRET).update(base).digest("${enc}");`);
	js.push("const authHeader = `" + fill(auth.format, jsRef) + "`;");
	js.push(``);
	js.push(`const res = await fetch("${url}", {`);
	js.push(`  method: "${method}",`);
	js.push(`  headers: { "Content-Type": "application/json", "${auth.header}": authHeader },`);
	if (hasBody) js.push(`  body: JSON.stringify({ ${wrapField} }),`);
	js.push(`});`);
	js.push(`const data = await res.json();`);

	/* ---------- PHP ---------- */
	const phpRef = (v: string) => "{$" + v + "}";
	const php: string[] = [`<?php`, `$secret = "<SECRET>";`];
	for (const [k, f] of fieldEntries) {
		if (f.source === "signature") continue;
		if (f.const !== undefined) php.push(`$${k} = "${f.const}";`);
		else if (f.source === "timestamp")
			php.push(`$${k} = ${f.unit === "s" ? "time()" : "(int) round(microtime(true) * 1000)"};`);
		else if (f.source === "random") php.push(`$${k} = bin2hex(random_bytes(${Math.ceil((f.length ?? 16) / 2)}));`);
		else php.push(`$${k} = "${f.placeholder ?? "<" + k.toUpperCase() + ">"}";`);
	}
	php.push(``);
	php.push("$payload = '" + compact.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "';");
	php.push(`$${wrapField} = base64_encode($payload);`);
	php.push(``);
	php.push('$base = "' + fill(auth.signature.base, phpRef) + '";');
	php.push(
		`$${sigKey} = ${enc === "base64" ? `base64_encode(hash_hmac("${hash}", $base, $secret, true))` : `hash_hmac("${hash}", $base, $secret)`};`,
	);
	php.push('$authHeader = "' + fill(auth.format, phpRef) + '";');
	php.push(``);
	php.push(`$ch = curl_init("${url}");`);
	php.push(`curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);`);
	php.push(`curl_setopt($ch, CURLOPT_CUSTOMREQUEST, "${method}");`);
	php.push(`curl_setopt($ch, CURLOPT_HTTPHEADER, [`);
	php.push(`    "Content-Type: application/json",`);
	php.push(`    "${auth.header}: " . $authHeader,`);
	php.push(`]);`);
	if (hasBody) php.push(`curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(["${wrapField}" => $${wrapField}]));`);
	php.push(`$response = curl_exec($ch);`, `curl_close($ch);`);

	return { curl, js: js.join("\n"), php: php.join("\n") };
};

const indent = (text: string, pad: string): string =>
	text
		.split("\n")
		.map((line, i) => (i === 0 ? line : pad + line))
		.join("\n");

/* ------------------------------------------------------------------ */
/* Schema tables & rich descriptions                                  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Rich description — recursive renderer for the lines/blocks structure */
/* ------------------------------------------------------------------ */

const RichText = ({ children }: { children: any }) => (
	<Typo
		variant="medium"
		color="rgba(255,255,255,0.82)"
		sx={{ display: "block", fontSize: "1.05rem", lineHeight: "1.7", maxWidth: "74ch", letterSpacing: "0.1px" }}>
		{children}
	</Typo>
);

// The backend uses two shapes interchangeably: {head, lines} and {title, content:{lines}}.
const blockHead = (n: any): string => n?.head ?? n?.title ?? "";
const blockLines = (n: any): any[] => {
	if (Array.isArray(n?.lines)) return n.lines;
	if (Array.isArray(n?.content?.lines)) return n.content.lines;
	if (Array.isArray(n?.content)) return n.content;
	return [];
};

const RichTable = ({ node }: { node: any }) => {
	const headers: string[] = node.headers ?? [];
	// Backend ships the misspelled `gridTempalateColumns` in places — accept both.
	const grid = node.gridTemplateColumns ?? node.gridTempalateColumns ?? headers.map(() => "max-content").join(" ");

	return (
		<VBox gap="6px">
			{blockHead(node) && <AuthCaption>{blockHead(node)}</AuthCaption>}
			<Box
				sx={{
					display: "grid",
					gap: "1px",
					padding: "1px",
					boxSizing: "border-box",
					backgroundColor: "rgba(255,255,255,0.05)",
					borderRadius: "6px",
					overflow: "hidden",
					gridTemplateColumns: grid,
				}}>
				<Box
					sx={{
						display: "contents",
						"&>div": { padding: "10px", fontSize: "12px", boxSizing: "border-box" },
					}}>
					{headers.map((header: string, i: number) => (
						<Typo
							key={i}
							variant="medium"
							bold
							color="rgba(255,255,255,0.7)"
							sx={{ backgroundColor: "rgba(7, 11, 22, 0.685)" }}>
							{header}
						</Typo>
					))}
					{node.rows?.map((row: any[], r: number) =>
						row.map((cell: any, c: number) => (
							<Typo key={`${r}-${c}`} variant="medium" sx={{ backgroundColor: "panelBackgroundPrimary" }}>
								{cell}
							</Typo>
						)),
					)}
				</Box>
			</Box>
		</VBox>
	);
};

const RichCode = ({ node }: { node: any }) => {
	const head = blockHead(node);
	const code = typeof node.content === "string" ? node.content : (node.code ?? "");
	return (
		<VBox gap="6px">
			{head && <AuthCaption>{head}</AuthCaption>}
			<CodeBlock code={code} wrap />
		</VBox>
	);
};

// Top-level descriptor block — collapsible panel with a large neutral heading.
const CollapsibleBlock = ({ node }: { node: any }) => {
	// Collapsed by default; only blocks explicitly flagged `opened: true` start open.
	const [open, setOpen] = useState<boolean>(node.opened === true);
	return (
		<Box
			sx={{
				backgroundColor: "rgba(0,0,0,0.18)",
				border: "1px solid rgba(255,255,255,0.07)",
				borderRadius: "8px",
				overflow: "hidden",
			}}>
			<HBox
				onClick={() => setOpen(!open)}
				sx={{
					alignItems: "center",
					gap: "12px",
					padding: "18px 22px",
					cursor: "pointer",
					transition: "background-color 0.2s ease",
					"&:hover": { backgroundColor: "rgba(0,0,0,0.25)" },
				}}>
				<IconChevron open={open} color="rgba(255,255,255,0.6)" />
				<Typo
					color="rgba(255,255,255,0.96)"
					sx={{ fontSize: "19px", fontWeight: 600, lineHeight: "1.3", letterSpacing: "0.2px" }}>
					{blockHead(node)}
				</Typo>
			</HBox>
			{open && (
				<Box sx={{ padding: "4px 22px 22px 22px" }}>
					<RichLines lines={blockLines(node)} depth={1} />
				</Box>
			)}
		</Box>
	);
};

const RichBlock = ({ node, depth }: { node: any; depth: number }) => {
	const head = blockHead(node);
	const lines = blockLines(node);

	// Top-level blocks become collapsible panels; headless ones just render lines.
	if (depth === 0) {
		if (!head) return <RichLines lines={lines} depth={1} />;
		return <CollapsibleBlock node={node} />;
	}

	// Nested block — neutral sub-section with a grey rule.
	return (
		<VBox gap="10px" sx={{ borderLeft: "2px solid rgba(255,255,255,0.12)", paddingLeft: "16px" }}>
			{head && (
				<Typo variant="medium" bold color="rgba(255,255,255,0.92)" sx={{ fontSize: "15.5px" }}>
					{head}
				</Typo>
			)}
			<RichLines lines={lines} depth={depth + 1} />
		</VBox>
	);
};

// Backward-compat: the older {title, code, table, spacer} node shape.
const LegacyNode = ({ node }: { node: any }) => (
	<>
		{node.title && (
			<Typo variant="medium" bold color="rgba(255,255,255,0.9)" sx={{ fontSize: "13px", marginTop: "4px" }}>
				{node.title}
			</Typo>
		)}
		{node.code && <CodeBlock code={node.code} wrap />}
		{node.table && <RichTable node={node.table} />}
		{node.spacer && <Spacer size={node.spacer} />}
	</>
);

const RichNode = ({ node, depth }: { node: any; depth: number }) => {
	if (node == null) return null;
	if (typeof node === "string") return <RichText>{node}</RichText>;
	if (Array.isArray(node)) return <RichLines lines={node} depth={depth} />;
	switch (node.type) {
		case "block":
			return <RichBlock node={node} depth={depth} />;
		case "code":
			return <RichCode node={node} />;
		case "table":
			return <RichTable node={node} />;
		default:
			return <LegacyNode node={node} />;
	}
};

const RichLines = ({ lines, depth = 0 }: { lines: any[]; depth?: number }) => {
	if (!Array.isArray(lines)) return null;
	return (
		<VBox gap={depth === 0 ? "18px" : "13px"}>
			{lines.map((line: any, i: number) => (
				<RichNode key={i} node={line} depth={depth} />
			))}
		</VBox>
	);
};

const ParsedDescription = ({ description }: { description: string }) => {
	if (description && typeof description === "string" && description.trim().startsWith("{")) {
		try {
			const parsed = JSON.parse(description);
			if (parsed && Array.isArray(parsed.lines)) return <RichLines lines={parsed.lines} />;
			// Object without `lines` (e.g. only `auth`) — nothing to render here.
			return null;
		} catch {
			// Невалидный JSON в description — показываем сырой текст
			return <Typo variant="medium">{description}</Typo>;
		}
	}

	return <Typo variant="medium">{description}</Typo>;
};

const SCHEMA_LINE = "rgba(255,255,255,0.15)";
const GUTTER_W = 22;
const CONNECT_Y = 17;

const NameChip = ({ name }: { name: string }) => (
	<Box
		sx={{
			flex: "0 1 auto",
			minWidth: 0,
			backgroundColor: "rgba(255,255,255,0.08)",
			border: "1px solid rgba(255,255,255,0.06)",
			borderRadius: "5px",
			padding: "2px 7px",
		}}>
		<Typo
			sx={{
				fontFamily: "monospace",
				fontSize: "12.5px",
				color: "rgba(255,255,255,0.92)",
				overflowWrap: "anywhere",
			}}>
			{name}
		</Typo>
	</Box>
);

// Allowed value from the schema's `values` enum — accent-tinted so it reads as a constraint,
// not as prose.
const ValueChip = ({ value, muted = false }: { value: any; muted?: boolean }) => (
	<Box
		sx={{
			flex: "0 0 auto",
			backgroundColor: muted ? "rgba(255,255,255,0.06)" : "rgba(255,235,59,0.10)",
			border: `1px solid ${muted ? "rgba(255,255,255,0.10)" : "rgba(255,235,59,0.28)"}`,
			borderRadius: "4px",
			padding: "1px 6px",
		}}>
		<Typo
			sx={{
				fontFamily: "monospace",
				fontSize: "11.5px",
				color: muted ? "rgba(255,255,255,0.7)" : "rgba(255,235,59,0.92)",
				overflowWrap: "anywhere",
			}}>
			{String(value)}
		</Typo>
	</Box>
);

// Caption for a constraint row inside the parameter plaque ("enum:", "default:").
const ConstraintLabel = ({ children }: { children: ReactNode }) => (
	<Typo
		variant="small"
		color="rgba(255,255,255,0.45)"
		sx={{ fontSize: "10px", letterSpacing: "0.06em", textTransform: "uppercase", flex: "0 0 auto" }}>
		{children}
	</Typo>
);

// Vertical guide for an ancestor level (drawn only when that ancestor has more siblings below).
const TreeGutter = ({ line }: { line: boolean }) => (
	<Box
		sx={{
			flex: "0 0 auto",
			width: `${GUTTER_W}px`,
			alignSelf: "stretch",
			position: "relative",
			"&::before": line
				? {
						content: '""',
						position: "absolute",
						left: "10px",
						top: 0,
						bottom: 0,
						width: "1px",
						backgroundColor: SCHEMA_LINE,
					}
				: {},
		}}
	/>
);

// Elbow connecting a node to its parent: ├─ (siblings below) or └─ (last child).
const TreeElbow = ({ isLast }: { isLast: boolean }) => (
	<Box
		sx={{
			flex: "0 0 auto",
			width: `${GUTTER_W}px`,
			alignSelf: "stretch",
			position: "relative",
			"&::before": {
				content: '""',
				position: "absolute",
				left: "10px",
				top: 0,
				height: isLast ? `${CONNECT_Y}px` : "100%",
				width: "1px",
				backgroundColor: SCHEMA_LINE,
			},
			"&::after": {
				content: '""',
				position: "absolute",
				left: "10px",
				top: `${CONNECT_Y}px`,
				width: "9px",
				height: "1px",
				backgroundColor: SCHEMA_LINE,
			},
		}}
	/>
);

const TreeNode = ({
	name,
	node,
	depth,
	isLast,
	ancestorsLast,
	parentPath,
}: {
	name: string;
	node: any;
	depth: number;
	isLast: boolean;
	ancestorsLast: boolean[];
	parentPath: string;
}) => {
	const children = schemaChildren(node);
	const hasChildren = children.length > 0;
	const enumValues = allowedValues(node);
	const hasDefault = isPrimitive(node?.default);
	const hasDetails = typeof node.details === "string" && !!node.details;
	const hasRegex = typeof node.regex === "string" && !!node.regex;
	const [open, setOpen] = useState(true);

	return (
		<>
			<HBox sx={{ alignItems: "stretch", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
				{depth > 0 && ancestorsLast.map((al, i) => <TreeGutter key={i} line={!al} />)}
				{depth > 0 && <TreeElbow isLast={isLast} />}
				<VBox sx={{ flex: "1 1 auto", minWidth: 0, padding: "6px 0", gap: "3px" }}>
					<HBox sx={{ alignItems: "center", gap: "8px", minWidth: 0 }}>
						{hasChildren ? (
							<Box
								onClick={() => setOpen(!open)}
								sx={{ flex: "0 0 auto", display: "flex", cursor: "pointer" }}>
								<IconChevron open={open} size="10" color="rgba(255,255,255,0.55)" />
							</Box>
						) : (
							<Box sx={{ flex: "0 0 auto", width: "10px" }} />
						)}
						{parentPath && (
							<Typo
								color="rgba(255,255,255,0.4)"
								sx={{
									fontSize: "12px",
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
									flex: "0 3 auto",
									minWidth: "14px",
								}}>
								{parentPath}.
							</Typo>
						)}
						<NameChip name={name} />
						<Typo sx={{ fontSize: "11px", fontFamily: "monospace" }} bold color={coloTypes[node.type]}>
							{node.type}
						</Typo>
						{node.optional && (
							<Typo sx={{ fontSize: "10px" }} bold color="rgba(106,134,255,0.85)">
								optional
							</Typo>
						)}
					</HBox>
					{(hasDetails || hasRegex || enumValues.length > 0 || hasDefault) && (
						<VBox
							sx={{
								gap: "5px",
								marginTop: "4px",
								// Text starts under the parameter name (chevron 10px + gap 8px); no left
								// border so it doesn't compete with the tree's vertical guides.
								padding: "8px 12px 8px 18px",
								backgroundColor: "rgba(0,0,0,0.2)",
								borderRadius: "5px",
							}}>
							{hasDetails && (
								<Typo
									variant="medium"
									color="rgba(255,255,255,0.8)"
									sx={{ fontSize: "13px", lineHeight: "1.55" }}>
									{node.details}
								</Typo>
							)}
							{enumValues.length > 0 && (
								<HBox sx={{ gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
									<ConstraintLabel>enum</ConstraintLabel>
									{enumValues.map((v, i) => (
										<ValueChip key={i} value={v} />
									))}
								</HBox>
							)}
							{hasDefault && (
								<HBox sx={{ gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
									<ConstraintLabel>default</ConstraintLabel>
									<ValueChip value={node.default} muted />
								</HBox>
							)}
							{hasRegex && (
								<Typo
									variant="small"
									color="rgba(255,255,255,0.45)"
									sx={{ fontFamily: "monospace", fontSize: "10px", wordBreak: "break-all" }}>
									regex: {node.regex}
								</Typo>
							)}
						</VBox>
					)}
				</VBox>
			</HBox>
			{open && hasChildren && (
				<TreeRows
					entries={children}
					depth={depth + 1}
					ancestorsLast={depth === 0 ? [] : [...ancestorsLast, isLast]}
					path={parentPath ? parentPath + "." + name : name}
				/>
			)}
		</>
	);
};

const TreeRows = ({
	entries,
	depth,
	ancestorsLast,
	path,
}: {
	entries: [string, any][];
	depth: number;
	ancestorsLast: boolean[];
	path: string;
}) => (
	<>
		{entries.map(([name, node], i) => (
			<TreeNode
				key={name}
				name={name}
				node={node}
				depth={depth}
				isLast={i === entries.length - 1}
				ancestorsLast={ancestorsLast}
				parentPath={path}
			/>
		))}
	</>
);

const SchemaTree = ({ schema }: { schema: any }) => {
	const entries = Object.entries(schema ?? {}).filter(([k]) => k !== "0");
	if (entries.length === 0) return null;
	return (
		<Box sx={{ border: "1px solid rgba(255,255,255,0.06)", borderRadius: "6px", padding: "0 14px" }}>
			<TreeRows entries={entries as [string, any][]} depth={0} ancestorsLast={[]} path="" />
		</Box>
	);
};
