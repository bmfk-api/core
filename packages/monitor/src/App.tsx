import { S_AUTH_STATUS } from "./services/Auth";
import { Metrix } from "./Metrix";
import { Login } from "./features/Login";
import { VBox } from "ui/src/box/Box";
import { getDefaultDarkTheme, GlobalTheme } from "ui/src/theme/GlobalTheme";

const theme = getDefaultDarkTheme();

function App() {
	const state = S_AUTH_STATUS.use([]);

	let content;
	switch (state) {
		case "authorized":
			content = <Metrix />;
			break;
		case "unauthorized":
		case "checking":
		case "enroll":
			content = <Login />;
			break;
		default:
			content = <VBox sx={{ padding: "20px" }}>Unknown state: {state}</VBox>;
	}

	return <GlobalTheme theme={theme}>{content}</GlobalTheme>;
}

export default App;
