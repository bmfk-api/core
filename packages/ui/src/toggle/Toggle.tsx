import { useTheme } from "styled-components";
import { Box } from "../box/Box";
import { ITheme } from "../theme/GlobalTheme";

// STYLES
export const getDefaultToggleLightTheme = {
	background: "#a7a7a7",
	backgroundSelected: "#66bb6a",
	toggle: "#FFFFFF",
};

//!TODO: colors;
export const getDefaultToggleDarkTheme: typeof getDefaultToggleLightTheme = {
	background: "#a7a7a7",
	backgroundSelected: "#66bb6a",
	toggle: "#FFFFFF",
};

interface IToggleProps {
	selected: boolean;
	disabled?: boolean;
	onChange: (selected: boolean) => void;
	readOnly?: boolean;
}

export const Toggle = ({
	selected,
	onChange,
	disabled,
	readOnly,
}: IToggleProps) => {
	const theme = useTheme() as ITheme;
	const style = theme.toggle;

	return (
		<Box
			onClick={e => {
				e?.stopPropagation();
				!disabled && !readOnly && onChange(!selected);
			}}
			sx={{
				borderRadius: "27px",
				cursor: "pointer",
				backgroundColor: selected
					? style?.backgroundSelected
					: style?.background,
				width: "50px",
				height: "28px",
				transition: ".4s",
				position: "relative",
				display: "inline-block",
			}}>
			<Box
				sx={{
					transition: ".4s",
					position: "absolute",
					top: "4px",
					left: "4px",
					width: "20px",
					height: "20px",
					borderRadius: "50%",
					backgroundColor: style?.toggle,
					transform: selected
						? "translateX(22px)"
						: "translateX(0px)",
				}}
			/>
		</Box>
	);
};
