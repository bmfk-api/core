import { Signal } from "../signals";
import React, { JSX, useEffect, useState } from "react";
import { useTheme } from "styled-components";
import { Box, isCSS } from "../box/Box";
import { Typo } from "../text/Typo";
import { ITheme } from "../theme/GlobalTheme";

// STYLES
export const getDefaultTableLightTheme = {
	cellBackground: "#FFFFFF",
	cellBackgroundHover: "rgb(249, 251, 255)",
	cellBackgroundExpanded: "#373948",
	cellColorExpanded: "#FFFFFF",
	headerBackground: "#f5f5f5",
	cellBorderBottom: "1px solid rgba(0,0,0,.1)",
	cellBorderTop: "1px solid transparent",
};

export const getDefaultTableDarkTheme: typeof getDefaultTableLightTheme = {
	cellBackground: "rgba(0,0,0,0)",
	cellBackgroundHover: "rgba(0,0,0,.1)",
	cellBackgroundExpanded: "#373948",
	cellColorExpanded: "#FFFFFF",
	headerBackground: "rgba(0,0,0,.4)",
	cellBorderBottom: "1px solid rgba(0,0,0,.6)",
	cellBorderTop: "1px solid rgba(255,255,255,.06)",
};

export interface IHeaderValue {
	value?: string | JSX.Element | null;
	sx?: React.CSSProperties;
	gridColumn?: string;
}

export interface ICellFactoryResult {
	content: string | JSX.Element | null;
	sx?: React.CSSProperties;
}
export interface ITableProps<T> {
	headers?: IHeaderValue[];
	data: T[];
	cellFactory?: (
		row: T,
		cell: any,
		index: number,
		key?: number,
		name?: string,
		expanded?: boolean,
		rowID?: string
	) => ICellFactoryResult;
	headerFactory?: (
		value: string | JSX.Element | null,
		index: number
	) => ICellFactoryResult;
	gridTemplateColumns?: string;
	headless?: boolean;
	sx?: React.CSSProperties;
	onRowClick?: (row: T, cell: any, rowID: string) => void;
	onHeadClick?: (value: string) => void;
	appendCells?: {
		gridColumn?: string;
		value: string;
		header?: string | JSX.Element | null;
	}[];
	//ignore?: Array<keyof T>;
	order?: Array<keyof T>;
	scrollable?: boolean;
	direction?: "row" | "column";
	ignoreClick?: boolean;
}

export interface ICellProps {
	sx?: React.CSSProperties;
	children?: string | JSX.Element | null;
	onClick?: () => void;
	isExpandable: boolean;
	expandedContent: JSX.Element | null;
	rowID: string;
	isParentInternal: boolean;
}

export interface IHeaderProps {
	sx?: React.CSSProperties;
	children?: string | JSX.Element | null;
	onClick?: () => void;
}

const createHeader = (req: ITableProps<any>, h: IHeaderValue, i: number) => {
	let sx = h.sx ?? {};
	let renderValue;
	if (req.headerFactory) {
		const factoryResult = parseCellResult(
			req.headerFactory(h.value ?? null, i)
		);
		if (isCSS(factoryResult))
			sx = { ...sx, ...(factoryResult as React.CSSProperties) };
		else renderValue = factoryResult as any;
	} else {
		const parsedValue = parseCellResult(h.value);
		if (isCSS(parsedValue)) sx = parsedValue as React.CSSProperties;
		else renderValue = parsedValue as any;
	}

	return (
		<DefaultTableHead
			onClick={() => {
				if (req.onHeadClick) req.onHeadClick(h.value as string);
			}}
			key={i}
			sx={{ ...h.sx, ...sx }}>
			{renderValue ?? h.value}
		</DefaultTableHead>
	);
};

const parseCellResult = (
	cellResult: any
): React.CSSProperties | string | JSX.Element | null => {
	if (!cellResult) return null;

	if (React.isValidElement(cellResult)) {
		return cellResult;
	}

	let renderValue = null;
	if (isCSS(cellResult)) return cellResult as React.CSSProperties;

	if (typeof cellResult === "object") {
		try {
			renderValue = JSON.stringify(cellResult);
		} catch (e) {
			renderValue = "object{}";
		}
	} else {
		renderValue = cellResult + "";
	}

	if (
		renderValue.indexOf("-") !== -1 &&
		renderValue.indexOf("T") !== -1 &&
		renderValue.indexOf(":") !== -1
	) {
		try {
			if (renderValue.indexOf("Z") !== -1)
				renderValue = new Date(cellResult).toLocaleString();
			else renderValue = new Date(cellResult).toLocaleString();

			if (renderValue.toLowerCase().indexOf("invalid") !== -1)
				renderValue = cellResult + "";
		} catch (e) {}
	}

	return renderValue;
};

interface ITableExpand {
	rowID: string;
	content: JSX.Element;
	isParentInternal: boolean;
}
export const S_TABLE_EXPAND = new Signal<ITableExpand>();

export const Table = <T,>(req: ITableProps<T>) => {
	// handle if date is APIResponse date
	const theme = useTheme() as ITheme;
	const style = theme.table;
	const [tableID, _] = useState<string>(
		+new Date() + "" + Math.round(Math.random() * 100000)
	);

	let data = req.data;
	let order = req.order;
	let headers = req.headers;
	let ignore: string[] | null = [];

	if (!headers || headers.length === 0) {
		if (Array.isArray(data) && data.length > 0) {
			// find headers
			let maxKeys = 0;
			let headerIndex = 0;
			for (let i in data) {
				const obj = data[i];
				if (obj && typeof obj === "object") {
					const keys = Object.keys(obj).length;
					if (keys > maxKeys) {
						maxKeys = keys;
						headerIndex = parseInt(i);
					}
				}
			}

			if (typeof (data as any)[headerIndex] === "object") {
				headers = Object.keys((data as any)[headerIndex]).map(k => {
					return { value: k };
				});
			} else {
				headers = [{ value: "Value" }];
			}

			if (req.appendCells) {
				headers = [
					...(headers ?? []),
					...req.appendCells.map(c => {
						return { value: c.header, gridColumn: c.gridColumn };
					}),
				];
			}

			if (order && req.data) {
				for (let i of headers) {
					if (i.value && !order.includes(i.value as string as any)) {
						ignore.push((i.value + "").toLowerCase().trim());
					}
				}
			} else {
				ignore = null;
			}
		}
	}

	if (req.appendCells && !order && headers) {
		let treelines = req.appendCells.find(
			val => val.value === "__treelines"
		);
		if (treelines) {
			let neworder = headers.map(val => val.value as string);
			const tree = neworder?.filter(val => val === "__treelines");
			const notree = neworder?.filter(val => val !== "__treelines");
			order = [...(tree as any), ...(notree as any)];
		}
	}

	if (order && headers) {
		headers.sort((a, b) => {
			const indexA = order!.indexOf((a.value + "") as any);
			const indexB = order!.indexOf((b.value + "") as any);
			if (indexA !== -1 && indexB !== -1) {
				return indexA - indexB;
			}
			if (indexA !== -1) return -1;
			if (indexB !== -1) return 1;
			return 0; //a.localeCompare(b);
		});
	}

	let gridTemplateColumns = headers
		?.map(h => {
			return h.gridColumn ? h.gridColumn : "auto";
		})
		.join(" ");
	if (req.direction === "column") gridTemplateColumns = "max-content 1fr";

	if (req.gridTemplateColumns) gridTemplateColumns = req.gridTemplateColumns;

	let counter = 0;

	const content = (
		<Box
			sx={{
				display: "grid",
				gridTemplateColumns,
				rowGap: "0px",

				...req.sx,
			}}>
			{!req.headless &&
				req.direction !== "column" &&
				headers &&
				headers.map((h, i) => {
					return createHeader(req, h, i);
				})}

			{data &&
				data.length &&
				data.map((row: any, index: number) => {
					let value = [row];

					if (typeof row === "object") {
						value = [];

						if (order) {
							for (let i of order) {
								// check if ignore exists & key in ignore, continue
								if (
									ignore &&
									ignore.includes((i as string).toLowerCase())
								)
									continue;

								// Appending cells
								const appendCell = req.appendCells?.find(
									val => val.header === i
								);
								if (appendCell) {
									value.push(appendCell.value);
								} else {
									value.push(row[i]);
								}
							}
						} else {
							for (let key in row) {
								value.push(row[key]);
							}

							if (req.appendCells) {
								value = [
									...value,
									...req.appendCells.map(c => c.value),
								];
							}
						}

						if (
							req.direction === "column" &&
							headers &&
							!req.headless
						) {
							value = value.flatMap((el, index) => [
								headers[index],
								el,
							]);
						}
					}

					return (
						<TableRow
							key={tableID + "_row_" + index}
							index={index}
							req={req}
							value={value}
							style={style}
							headers={headers}
							counter={counter}
							row={row}
							tableID={tableID}
						/>
					);
				})}
		</Box>
	);

	if (req.scrollable) {
		return (
			<Box
				sx={{
					flexGrow: 1,
					overflow: "auto",
				}}>
				{content}
			</Box>
		);
	}

	return content;
};

const TableRow = <T,>({
	index,
	req,
	value,
	style,
	headers,
	counter,
	row,
	tableID,
}: {
	index: number;
	req: ITableProps<T>;
	value: any[];
	style: any;
	headers: any;
	counter: number;
	row: T;
	tableID: string;
}) => {
	const rowID = tableID + "_row_" + index;
	const [isParentInternal, setIsParentInternal] = useState<boolean>(false);
	const [expandedContent, setExpandedContent] = useState<JSX.Element | null>(
		null
	);
	useEffect(() => {
		const handlerID = S_TABLE_EXPAND.subscribe(data => {
			if (data.rowID !== rowID) {
				const tid = data.rowID.split("_").shift();
				if (tid + "" !== tableID + "") return;
				if (expandedContent) setExpandedContent(null);
				return;
			}

			if (!expandedContent) setExpandedContent(data.content);
			else setExpandedContent(null);
			setIsParentInternal(data.isParentInternal);
		});
		return () => {
			S_TABLE_EXPAND.unsubscribe(handlerID);
		};
	}, [rowID, expandedContent]);

	let hover = true;
	let cursor =
		req.onRowClick !== null &&
		req.onRowClick !== undefined &&
		typeof req.onRowClick === "function";

	if (req.ignoreClick) {
		//cursor = false;
		hover = false;
	}
	if (expandedContent) hover = false;
	if (req.direction === "column") hover = false;

	return (
		<Box
			key={tableID + "_row_" + index}
			sx={{
				display: "contents",
				cursor: cursor ? "pointer" : "default",
				"&>div": {
					transition: "background-color 0.2s",
				},
				"&>div:nth-child(1)": {
					//borderRadius:"6px 0px 0px 6px",
				},
				"&>div:last-child": {
					//borderRadius:"0px 6px 6px 0px",
				},

				"&:hover > div": {
					backgroundColor: hover
						? style?.cellBackgroundHover
						: undefined,
				},
			}}>
			{value.map((value, cellIndex: number) => {
				if (req.direction === "column" && headers && !req.headless) {
					if (cellIndex % 2 === 0)
						return createHeader(
							req,
							value as IHeaderValue,
							cellIndex
						);
				}

				let sx = {};
				let renderValue;
				if (req.cellFactory) {
					let name = headers?.[cellIndex]?.value as string;

					const factoryResult = req.cellFactory(
						row,
						value,
						cellIndex,
						counter++,
						name,
						expandedContent !== null,
						rowID
					);

					if (factoryResult.sx) sx = factoryResult.sx;
					if (factoryResult.content) {
						renderValue = parseCellResult(factoryResult.content);
					} else renderValue = parseCellResult(value);
				} else {
					const parsedValue = parseCellResult(value);
					if (isCSS(parsedValue))
						sx = parsedValue as React.CSSProperties;
					else renderValue = parsedValue as any;
				}

				const key = tableID + "_cell_" + index + "_" + cellIndex;

				// TREELINES
				if (value === "__treelines") {
					return (
						<Box
							key={key}
							sx={{
								...sx,
								backgroundColor: "transparent !important",
								border: "none",
								width: "30px",
								minWidth: "30px",
								maxWidth: "30px",
								display: "flex",
								alignItems: "center",
								padding: "0px",
								position: "relative",
								gap: "4px",
							}}>
							<Box
								sx={{
									borderBottom: "1px dotted rgba(0,0,0,.4)",
									marginLeft: "1px",
									width: "10px",
								}}
							/>

							<Box
								sx={{
									borderRadius: "50%",
									border: "1px solid rgba(0,0,0,.3)",
									width: "7px",
									height: "7px",
									minWidth: "7px",
									minHeight: "7px",
									backgroundColor: "rgba(0,0,0,.1)",
								}}
							/>
						</Box>
					);
				}

				return (
					<DefaultTableCell
						sx={sx}
						isExpandable={value === "__expandable"}
						isParentInternal={isParentInternal}
						expandedContent={expandedContent}
						rowID={rowID}
						onClick={() => {
							if (req.onRowClick)
								req.onRowClick(row, value, rowID);
						}}
						key={key}>
						{renderValue ?? value}
					</DefaultTableCell>
				);
			})}
		</Box>
	);
};

const DefaultTableHead = (req: IHeaderProps) => {
	const theme = useTheme() as ITheme;
	let styled =
		theme.table ??
		(theme.name === "light"
			? getDefaultTableLightTheme
			: getDefaultTableDarkTheme);

	const content =
		typeof req.children !== "object" ? (
			<Typo
				variant="caption"
				sx={{ textTransform: "uppercase", fontWeight: "600" }}>
				{req.children
					?.replaceAll("_", " ")
					.replace("ctime", "created at")
					.trim()}
			</Typo>
		) : (
			req.children
		);

	const isComponent =
		typeof req.children === "object" && React.isValidElement(req.children);

	return (
		<Box
			onClick={req.onClick}
			sx={{
				padding: "12px 20px",
				backgroundColor: styled.headerBackground,
				whiteSpace: "nowrap",
				overflow: isComponent ? undefined : "hidden",
				textOverflow: isComponent ? undefined : "ellipsis",
				alignContent: "center",
				...req.sx,
			}}>
			{content}
		</Box>
	);
};

const DefaultTableCell = (req: ICellProps) => {
	const theme = useTheme() as ITheme;

	let style =
		theme.table ??
		(theme.name === "light"
			? getDefaultTableLightTheme
			: getDefaultTableDarkTheme);

	let content =
		typeof req.children !== "object" ? (
			<Typo variant="medium">{req.children}</Typo>
		) : (
			req.children
		);

	const isComponent =
		typeof req.children === "object" && React.isValidElement(req.children);

	let defaultSX: React.CSSProperties = {
		padding: "16px",
		backgroundColor: style.cellBackground,
		borderBottom: style.cellBorderBottom,
		borderTop: style.cellBorderTop,
		alignContent: "center",
		overflow: isComponent ? undefined : "hidden",
		textOverflow: isComponent ? undefined : "ellipsis",
		color: "textPrimary",
	};

	if (!req.isExpandable && req.expandedContent) {
		defaultSX.backgroundColor = style.cellBackgroundExpanded;
		defaultSX.color = style.cellColorExpanded;
	}

	if (req.isExpandable) {
		defaultSX = {
			backgroundColor: "transparent !important",
			display: "grid",
			gridTemplateColumns: "max-content max-content 1fr",
			border: "none",
			cursor: "default",
			gridColumn: (req.isParentInternal ? "2" : "1") + " / -1",
		};
		content = null;
		if (req.expandedContent)
			content = (
				<>
					<Box sx={{ minWidth: "20px", width: "20px" }} />
					<Box
						sx={{
							borderLeft: "1px dotted rgba(0,0,0,.4)",
						}}
					/>
					{req.expandedContent}
				</>
			);
		if (content == null) return <div></div>;
	}

	const renderable = (
		<Box
			onClick={req.isExpandable ? undefined : req.onClick}
			sx={{
				...defaultSX,
				...req.sx,
			}}>
			{content}
		</Box>
	);

	return renderable;
};
