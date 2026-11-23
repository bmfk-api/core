/* ------------------------------------------------------------------ */
/* Shared presentational atoms                                        */
/*                                                                    */
/* Used by both the documentation view and the request builder modal, */
/* so the two stay visually identical.                                */
/* ------------------------------------------------------------------ */

import { ReactNode, useState } from "react";
import { Box, HBox } from "ui/src/box/Box";
import { Typo } from "ui/src/text/Typo";
import { IconCopy } from "ui/src/icons/IconCopy";

export const SectionLabel = ({ children, color }: { children: ReactNode; color: string }) => (
	<HBox
		sx={{
			alignItems: "center",
			gap: "8px",
			backgroundColor: "rgba(0,0,0,0.25)",
			padding: "9px 14px",
			borderRadius: "6px",
		}}>
		<Box sx={{ width: "8px", height: "8px", borderRadius: "2px", backgroundColor: color }} />
		<Typo
			variant="caption"
			sx={{ textTransform: "uppercase", letterSpacing: "0.5px", fontWeight: 700, opacity: 0.85 }}>
			{children}
		</Typo>
	</HBox>
);

export const CodeBlock = ({ code, wrap }: { code: string; wrap?: boolean }) => {
	const [copied, setCopied] = useState(false);

	const copy = () => {
		try {
			navigator.clipboard?.writeText(code);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch (e) {
			/* clipboard unavailable */
		}
	};

	return (
		<Box sx={{ position: "relative" }}>
			<Box
				onClick={copy}
				title="Copy"
				sx={{
					position: "absolute",
					top: "8px",
					right: "8px",
					display: "flex",
					alignItems: "center",
					gap: "5px",
					padding: "5px 8px",
					borderRadius: "4px",
					cursor: "pointer",
					backgroundColor: "rgba(255,255,255,0.08)",
					transition: "background-color 0.2s ease",
					"&:hover": { backgroundColor: "rgba(255,255,255,0.16)" },
				}}>
				<Box sx={{ display: "flex", filter: "invert(1) brightness(2)" }}>
					<IconCopy size="13" />
				</Box>
				<Typo variant="small" color={copied ? "#6aa76a" : "rgba(255,255,255,0.6)"} sx={{ fontSize: "11px" }}>
					{copied ? "Copied" : "Copy"}
				</Typo>
			</Box>
			<Box
				sx={{
					fontFamily: "monospace",
					color: "#0ffa52",
					backgroundColor: "rgba(0,0,0,0.7)",
					padding: "14px 76px 14px 16px",
					borderRadius: "4px",
					fontSize: "12px",
					lineHeight: "1.5",
					whiteSpace: wrap ? "pre-wrap" : "pre",
					wordBreak: wrap ? "break-all" : undefined,
					overflowX: wrap ? undefined : "auto",
				}}>
				{code}
			</Box>
		</Box>
	);
};
