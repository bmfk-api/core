import { TThreatLevel } from "../types";

export const levelColor = (l: TThreatLevel): string =>
	l === "high" ? "#bb5656" : l === "suspicious" ? "#e9b61e" : "#8a8699";
