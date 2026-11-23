import { styled } from "styled-components";
import { ITheme } from "ui/src/theme/GlobalTheme";

// Plain themed text input with a focus accent that fits the palette
// (the kit Input hardcodes a clashing bright blue focus border).
export const TextInput = styled.input<{ theme: ITheme }>`
	width: 100%;
	box-sizing: border-box;
	padding: 13px 14px;
	border-radius: 6px;
	font-size: 0.9rem;
	outline: none;
	color: ${({ theme }) => theme.colors.textPrimary};
	background-color: ${({ theme }) => theme.colors.inputBackgroundPrimary};
	border: 1px solid ${({ theme }) => theme.colors.inputBorderPrimary};
	transition: border-color 0.2s;
	&:focus {
		border-color: #5390d9;
	}
	&::placeholder {
		color: rgba(255, 255, 255, 0.35);
	}
`;
