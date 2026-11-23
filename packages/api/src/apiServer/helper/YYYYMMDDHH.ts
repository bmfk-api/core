export function YYYYMMDDHH(
	date: Date,
	format: "yyyymmddhhmm"|"yyyymmddhh" | "yyyymmdd" | "yyyymm" = "yyyymmddhh",
): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0"); // Месяцы от 0 до 11
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");

	switch (format) {
		case "yyyymmddhh":
			return `${year}${month}${day}${hours}`;
		case "yyyymmdd":
			return `${year}${month}${day}`;
		case "yyyymm":
			return `${year}${month}`;
		case "yyyymmddhhmm":
			return `${year}${month}${day}${hours}${minutes}`;
		default:
			return `${year}${month}${day}${hours}`;
	}
}

export function YYYYMMDDHH_toDate(yyyymmddhh: number): Date {
	const str = String(yyyymmddhh);
	const year = parseInt(str.slice(0, 4), 10);
	const month = parseInt(str.slice(4, 6), 10) - 1; // Месяцы от 0 до 11
	const day = parseInt(str.slice(6, 8), 10);
	const hours = parseInt(str.slice(8, 10), 10);
	return new Date(year, month, day, hours);
}

