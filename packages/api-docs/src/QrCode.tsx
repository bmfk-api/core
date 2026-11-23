import { useMemo } from "react";
import qrcode from "qrcode-generator";

// Rendered locally: the otpauth URI carries the TOTP secret, so it must never
// be sent to an external QR-image service.
export const QrCode = ({ value, size = 200 }: { value: string; size?: number }) => {
	const svg = useMemo(() => {
		const qr = qrcode(0, "M");
		qr.addData(value);
		qr.make();
		const n = qr.getModuleCount();
		const quiet = 4;
		const total = n + quiet * 2;
		let path = "";
		for (let r = 0; r < n; r++)
			for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
		return { total, path };
	}, [value]);

	return (
		<svg
			width={size}
			height={size}
			viewBox={`0 0 ${svg.total} ${svg.total}`}
			shapeRendering="crispEdges"
			role="img"
			aria-label="2FA enrollment QR code"
			style={{ background: "#fff", borderRadius: "6px", display: "block" }}>
			<path d={svg.path} fill="#000" />
		</svg>
	);
};
