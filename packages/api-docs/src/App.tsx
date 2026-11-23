import { S_AUTH_STATUS } from "./services/Auth";
import { Documentation } from "./Documentation";
import { Login } from "./Login";
import { VBox } from "ui/src/box/Box";
import { getDefaultDarkTheme, GlobalTheme } from "ui/src/theme/GlobalTheme";

const theme = getDefaultDarkTheme();

function App() {
	const state = S_AUTH_STATUS.use([]);

	let content;
	switch (state) {
		case "authorized":
			content = <Documentation />;
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
