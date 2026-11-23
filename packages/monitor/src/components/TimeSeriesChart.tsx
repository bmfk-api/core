import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTheme } from "styled-components";
import { Box, HBox, VBox } from "ui/src/box/Box";
import { Typo, TypoCaption } from "ui/src/text/Typo";
import { ITheme } from "ui/src/theme/GlobalTheme";

export interface IChartSeries {
	name: string;
	color: string;
	values: number[];
}

interface IProps {
	series: IChartSeries[];
	labels: string[]; // x-axis labels aligned with each value index
	height?: number;
	unit?: string;
	yMax?: number; // fixed maximum (e.g. 100 for CPU %), otherwise auto
	formatValue?: (n: number) => string;
	// Controlled hover index — when provided, the chart hands its mouse events
	// upstream instead of tracking hover locally. Used by the Correlations
	// page to synchronise the crosshair across 4 stacked charts.
	hover?: number | null;
	onHoverChange?: (index: number | null) => void;
	// Padding overrides — the Correlations page enforces equal left/right so
	// stacked plots align pixel-perfect on X.
	padding?: { top?: number; right?: number; bottom?: number; left?: number };
}

const PADDING = { top: 16, right: 16, bottom: 26, left: 48 };
const Y_TICKS = 4;

const niceMax = (raw: number): number => {
	if (raw <= 0) return 1;
	const mag = Math.pow(10, Math.floor(Math.log10(raw)));
	const norm = raw / mag;
	const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
	return step * mag;
};

// Trace a smooth curve through points using a Catmull-Rom → cubic Bézier spline.
// Assumes a path has already been started (beginPath). Falls back to straight
// segments for fewer than 3 points.
const smoothPath = (ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], yMin: number, yMax: number) => {
	if (pts.length === 0) return;
	// A cubic Bézier stays within the convex hull of its control points, so
	// clamping control-point Y to the plot bounds prevents the curve from
	// overshooting past the axes on sharp peaks/dips.
	const clamp = (y: number) => Math.max(yMin, Math.min(yMax, y));
	ctx.moveTo(pts[0].x, pts[0].y);
	if (pts.length < 3) {
		for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
		return;
	}
	for (let i = 0; i < pts.length - 1; i++) {
		const p0 = pts[i - 1] ?? pts[i];
		const p1 = pts[i];
		const p2 = pts[i + 1];
		const p3 = pts[i + 2] ?? p2;
		const cp1x = p1.x + (p2.x - p0.x) / 6;
		const cp1y = clamp(p1.y + (p2.y - p0.y) / 6);
		const cp2x = p2.x - (p3.x - p1.x) / 6;
		const cp2y = clamp(p2.y - (p3.y - p1.y) / 6);
		ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
	}
};

// Apply an alpha to any CSS color (hex #rgb/#rrggbb or rgb/rgba(...)).
const withAlpha = (color: string, alpha: number): string => {
	const a = Math.max(0, Math.min(1, alpha));
	if (color.startsWith("#")) {
		let hex = color.slice(1);
		if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
		const r = parseInt(hex.slice(0, 2), 16);
		const g = parseInt(hex.slice(2, 4), 16);
		const b = parseInt(hex.slice(4, 6), 16);
		return `rgba(${r},${g},${b},${a})`;
	}
	if (color.startsWith("rgb")) {
		const [r, g, b] = color.replace(/rgba?\(/, "").replace(/\)/, "").split(",");
		return `rgba(${r.trim()},${g.trim()},${b.trim()},${a})`;
	}
	return color;
};

export const TimeSeriesChart = ({
	series,
	labels,
	height = 200,
	unit = "",
	yMax,
	formatValue,
	hover: hoverProp,
	onHoverChange,
	padding: paddingOverride,
}: IProps) => {
	const theme = useTheme() as ITheme;
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const [width, setWidth] = useState(600);
	const [localHover, setLocalHover] = useState<number | null>(null);
	const controlled = hoverProp !== undefined;
	const hover = controlled ? hoverProp ?? null : localHover;
	const PAD = { ...PADDING, ...(paddingOverride ?? {}) };

	const fmt = useCallback(
		(n: number) => (formatValue ? formatValue(n) : `${Math.round(n * 100) / 100}${unit}`),
		[formatValue, unit],
	);
	const pointCount = labels.length;

	useLayoutEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		const ro = new ResizeObserver(entries => {
			const w = entries[0]?.contentRect.width;
			if (w) setWidth(Math.max(160, Math.floor(w)));
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;

		const dpr = window.devicePixelRatio || 1;
		canvas.width = width * dpr;
		canvas.height = height * dpr;
		canvas.style.width = width + "px";
		canvas.style.height = height + "px";
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);

		const plotW = width - PAD.left - PAD.right;
		const plotH = height - PAD.top - PAD.bottom;
		const gridColor = "rgba(255,255,255,.07)";
		const axisColor = "rgba(255,255,255,.35)";

		// Ignore NaN/Infinity when auto-scaling — those are "no data" markers
		// and would otherwise blow up niceMax or return NaN itself.
		const finiteValues = series.flatMap(s => s.values.filter(v => Number.isFinite(v)));
		const dataMax = finiteValues.length ? Math.max(...finiteValues) : 0;
		const max = yMax ?? niceMax(dataMax || 1);

		const xAt = (i: number) => PAD.left + (pointCount <= 1 ? plotW / 2 : (plotW * i) / (pointCount - 1));
		const yAt = (v: number) => PAD.top + plotH - (plotH * Math.min(v, max)) / max;

		// horizontal grid + y labels
		ctx.font = "11px -apple-system, sans-serif";
		ctx.textBaseline = "middle";
		ctx.textAlign = "right";
		for (let t = 0; t <= Y_TICKS; t++) {
			const v = (max / Y_TICKS) * t;
			const y = yAt(v);
			ctx.strokeStyle = gridColor;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(PAD.left, y);
			ctx.lineTo(width - PAD.right, y);
			ctx.stroke();
			ctx.fillStyle = axisColor;
			ctx.fillText(fmt(v), PAD.left - 8, y);
		}

		// x labels (sparse)
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		if (pointCount > 0) {
			const targetTicks = Math.max(2, Math.floor(plotW / 90));
			const stepX = Math.max(1, Math.ceil(pointCount / targetTicks));
			for (let i = 0; i < pointCount; i += stepX) {
				ctx.fillStyle = axisColor;
				ctx.fillText(labels[i], xAt(i), height - PAD.bottom + 8);
			}
		}

		// series: area fill + line, split into segments of consecutive finite
		// values so NaN gaps in the input produce visible breaks in the line.
		for (const s of series) {
			if (s.values.length === 0) continue;
			const segments: { x: number; y: number }[][] = [];
			let cur: { x: number; y: number }[] = [];
			for (let i = 0; i < s.values.length; i++) {
				const v = s.values[i];
				if (Number.isFinite(v)) {
					cur.push({ x: xAt(i), y: yAt(v) });
				} else if (cur.length > 0) {
					segments.push(cur);
					cur = [];
				}
			}
			if (cur.length > 0) segments.push(cur);
			if (segments.length === 0) continue;

			const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + plotH);
			grad.addColorStop(0, withAlpha(s.color, 0.33));
			grad.addColorStop(1, withAlpha(s.color, 0));

			for (const pts of segments) {
				ctx.save();
				ctx.beginPath();
				smoothPath(ctx, pts, PAD.top, PAD.top + plotH);
				ctx.lineTo(pts[pts.length - 1].x, PAD.top + plotH);
				ctx.lineTo(pts[0].x, PAD.top + plotH);
				ctx.closePath();
				ctx.fillStyle = grad;
				ctx.fill();
				ctx.restore();

				ctx.beginPath();
				smoothPath(ctx, pts, PAD.top, PAD.top + plotH);
				ctx.strokeStyle = s.color;
				ctx.lineWidth = 2;
				ctx.lineJoin = "round";
				ctx.stroke();
			}
		}

		// hover crosshair + points
		if (hover !== null && hover >= 0 && hover < pointCount) {
			const x = xAt(hover);
			ctx.strokeStyle = "rgba(255,255,255,.25)";
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x, PAD.top);
			ctx.lineTo(x, PAD.top + plotH);
			ctx.stroke();
			for (const s of series) {
				const v = s.values[hover];
				if (!Number.isFinite(v)) continue;
				ctx.beginPath();
				ctx.arc(x, yAt(v), 3.5, 0, Math.PI * 2);
				ctx.fillStyle = s.color;
				ctx.fill();
				ctx.strokeStyle = theme.colors.panelBackgroundPrimary;
				ctx.lineWidth = 2;
				ctx.stroke();
			}
		}
	}, [series, labels, width, height, yMax, hover, theme, fmt, pointCount, PAD.top, PAD.right, PAD.bottom, PAD.left]);

	const dispatchHover = (v: number | null) => {
		if (controlled) onHoverChange?.(v);
		else setLocalHover(v);
	};

	const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
		if (pointCount === 0) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const plotW = width - PAD.left - PAD.right;
		const rel = (e.clientX - rect.left - PAD.left) / plotW;
		const idx = Math.round(rel * (pointCount - 1));
		dispatchHover(Math.max(0, Math.min(pointCount - 1, idx)));
	};

	// When controlled, don't clear on leave — the parent decides whether the
	// pointer left the whole group (mouse between stacked charts must keep
	// the crosshair alive).
	const onLeave = () => {
		if (!controlled) setLocalHover(null);
	};

	const tooltipX =
		hover !== null
			? PAD.left + ((width - PAD.left - PAD.right) * hover) / Math.max(1, pointCount - 1)
			: 0;
	const tooltipRight = tooltipX > width / 2;

	return (
		<VBox sx={{ gap: "10px", width: "100%" }}>
			<HBox sx={{ gap: "16px", flexWrap: "wrap" }}>
				{series.map(s => (
					<HBox key={s.name} sx={{ gap: "6px", alignItems: "center" }}>
						<Box sx={{ width: "10px", height: "10px", borderRadius: "2px", backgroundColor: s.color }} />
						<TypoCaption>{s.name}</TypoCaption>
					</HBox>
				))}
			</HBox>

			<Box ref={wrapRef} sx={{ position: "relative", width: "100%" }}>
				{pointCount === 0 ? (
					<Box
						sx={{
							height: height + "px",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							border: "1px dashed rgba(255,255,255,.1)",
							borderRadius: "6px",
						}}>
						<TypoCaption>No data for the selected range</TypoCaption>
					</Box>
				) : (
					<canvas ref={canvasRef} onMouseMove={onMove} onMouseLeave={onLeave} />
				)}

				{hover !== null && pointCount > 0 && (
					<Box
						sx={{
							position: "absolute",
							top: "0px",
							[tooltipRight ? "right" : "left"]:
								(tooltipRight ? width - tooltipX + 8 : tooltipX + 8) + "px",
							backgroundColor: "rgba(0,0,0,.85)",
							border: "1px solid rgba(255,255,255,.12)",
							borderRadius: "6px",
							padding: "8px 10px",
							pointerEvents: "none",
							minWidth: "120px",
							zIndex: 5,
						}}>
						<TypoCaption>{labels[hover]}</TypoCaption>
						{series.map(s => (
							<HBox key={s.name} sx={{ gap: "8px", justifyContent: "space-between", marginTop: "2px" }}>
								<HBox sx={{ gap: "6px", alignItems: "center" }}>
									<Box
										sx={{
											width: "8px",
											height: "8px",
											borderRadius: "2px",
											backgroundColor: s.color,
										}}
									/>
									<TypoCaption>{s.name}</TypoCaption>
								</HBox>
								<Typo variant="medium">
									{Number.isFinite(s.values[hover]) ? fmt(s.values[hover]) : "—"}
								</Typo>
							</HBox>
						))}
					</Box>
				)}
			</Box>
		</VBox>
	);
};
