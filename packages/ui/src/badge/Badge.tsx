import type { JSX } from "react";
import React from "react";
import { Box, HBox } from "../box/Box";
import { Typo } from "../text/Typo";
import { isLightColor } from "../theme/GlobalTheme";

export const Badge = ({
	label,
	color,
	sx,
	icon,
}: {
	label: string;
	color?: string;
	sx?: React.CSSProperties;
	icon?: JSX.Element;
}) => {
	if (!color) {
		if (!label) label = "";
		let lbl = label.toLowerCase().trim();
		color = "#C3F0C0";

		if (lbl.indexOf("complet") !== -1 || lbl.indexOf("succes") !== -1)
			color = "#4285F4";

		if (
			lbl.indexOf("err") !== -1 ||
			lbl.indexOf("fail") !== -1 ||
			lbl.indexOf("damag") !== -1 ||
			lbl.indexOf("deni") !== -1 ||
			lbl.indexOf("reject") !== -1 ||
			lbl.indexOf("block") !== -1 ||
			lbl.indexOf("delet") !== -1 ||
			lbl.indexOf("disabl") !== -1
		)
			color = "#EA3568";

		if (
			lbl.indexOf("pendi") !== -1 ||
			lbl.indexOf("wait") !== -1 ||
			lbl.indexOf("norma") !== -1 ||
			lbl.indexOf("init") !== -1 ||
			lbl.indexOf("inact") !== -1 ||
			lbl.indexOf("creat") !== -1 ||
			lbl.indexOf("legac") !== -1
		)
			color = "#848799";

		if (lbl.indexOf("acquir") !== -1) color = "#9d4889";
		if (lbl.indexOf("terminal") !== -1) color = "#dac9b2";
		if (lbl.indexOf("rule") !== -1) color = "#9747FF";
		if (lbl.indexOf("channel") !== -1) color = "#a9d8e9";
		if (lbl.indexOf("merchant") !== -1) color = "#626691";
		if (lbl.indexOf("report") !== -1) color = "#c9dcce";
		if (lbl.indexOf("client") !== -1) color = "#e2c750";
		if (lbl.indexOf("group") !== -1) color = "#6d4a69";
	}

	return (
		<HBox
			center
			sx={{
				backgroundColor: color,
				padding: icon ? "10px 18px" : "6px 18px",
				borderRadius: "20px",
				position: "relative",
				...sx,
			}}>
			{icon && (
				<Box sx={{ left: "6px", position: "absolute", top: "6px" }}>
					{icon}
				</Box>
			)}
			<Typo
				sx={{ textTransform: "capitalize", fontSize: "10px" }}
				variant="medium"
				color={
					isLightColor(color)
						? "rgba(0,0,0,.9)"
						: "rgba(255,255,255,1)"
				}>
				{label}
			</Typo>
		</HBox>
	);
};
