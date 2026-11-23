import { useEffect } from "react";
import ReactDOM from "react-dom";
import { Box, HBox, VBox } from "ui/src/box/Box";
import { Typo } from "ui/src/text/Typo";

interface IProps {
	title?: string;
	onClose: () => void;
	children?: React.ReactNode;
	width?: string;
}

export const Modal = ({ title, onClose, children, width = "720px" }: IProps) => {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const node = (
		<Box
			onClick={onClose}
			sx={{
				position: "fixed",
				inset: "0",
				backgroundColor: "rgba(0,0,0,.6)",
				backdropFilter: "blur(2px)",
				zIndex: 10000,
				display: "flex",
				alignItems: "flex-start",
				justifyContent: "center",
				padding: "60px 20px",
				overflowY: "auto",
			}}>
			<VBox
				onClick={(e?: MouseEvent) => e?.stopPropagation()}
				sx={{
					width,
					maxWidth: "100%",
					backgroundColor: "panelBackgroundPrimary",
					border: "1px solid rgba(255,255,255,.08)",
					borderRadius: "8px",
					boxShadow: "0 20px 60px rgba(0,0,0,.5)",
					maxHeight: "calc(100vh - 120px)",
				}}>
				<HBox
					sx={{
						justifyContent: "space-between",
						alignItems: "center",
						padding: "16px 20px",
						borderBottom: "1px solid rgba(255,255,255,.08)",
					}}>
					<Typo variant="headMedium">{title ?? "Details"}</Typo>
					<Box
						onClick={onClose}
						sx={{
							cursor: "pointer",
							padding: "4px 10px",
							borderRadius: "4px",
							opacity: 0.6,
							"&:hover": { opacity: 1, backgroundColor: "rgba(255,255,255,.08)" },
						}}>
						✕
					</Box>
				</HBox>
				<Box sx={{ padding: "20px", overflowY: "auto" }}>{children}</Box>
			</VBox>
		</Box>
	);

	return ReactDOM.createPortal(node, document.body);
};
