import { Typo } from "ui/src/text/Typo";

// Section/field label used across dashboard panels. The kit's TypoCaption is too
// dim (opacity .6) on the dark panels, so we use a readable muted lavender that
// fits the project's purple-tinted palette.
export const LABEL_COLOR = "#9a96ad";

export const Label = ({ children, sx }: { children: React.ReactNode; sx?: React.CSSProperties }) => (
	<Typo variant="caption" sx={{ opacity: 1, color: LABEL_COLOR, letterSpacing: ".02em", ...sx }}>
		{children}
	</Typo>
);
