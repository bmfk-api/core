import React, { ChangeEvent, JSX, useState } from "react";
import { styled, useTheme } from "styled-components";
import { Box, createCSSFromObject, HBox } from "../box/Box";
import { Select } from "../select/Select";
import { Typo } from "../text/Typo";
import { ITheme } from "../theme/GlobalTheme";

export const InputBoxStyle = (disable: boolean, readOnly?: boolean) => {
  return {
    padding: "0px",
    border: disable
      ? "1px solid rgba(0,0,0,.1)"
      : "1px solid inputBorderPrimary",
    cursor: readOnly || disable ? "default" : "text",
    borderRadius: "4px",
    backgroundColor: disable ? "rgba(0,0,0,.1)" : "inputBackgroundPrimary",
    transition: "border .2s",
    "&:hover": {
      border: disable
        ? "1px solid rgba(0,0,0,.1)"
        : "1px solid inputBorderSecondary",
      transition: "border .2s",
    },
  };
};

export const InputFontStyle = () => {
  return {
    outline: "0",
    margin: "0",
    padding: "12px 16px",
    fontSize: "1rem",
  };
};

export interface IInputProps {
  sx?: React.CSSProperties;
  isCard?: boolean;
  sxInput?: React.CSSProperties;
  name: string;
  label?: string;
  iconRight?: JSX.Element;
  iconLeft?: JSX.Element;
  placeholder?: string;
  data: { [key: string]: string | number | boolean };
  onChange?: (value: string) => void;
  onFocusProps?: () => void;
  onBloorProps?: () => void;
  size?: string;
  subtitle?: string;
  type?:
    | "text"
    | "password"
    | "phone"
    | "textarea"
    | "date"
    | "search"
    | "dateInput"
    | "number";
  inputColor?: string;
  disable?: boolean;
  readOnly?: boolean;
  multiline?: boolean;
  maxLength?: number;
  disableAutocomplete?: boolean;
}

const TextAreaEl = styled.textarea<{ $size?: string; $color?: string }>`
  width: calc(100%);
  display: block;
  border: none;
  padding: 0;
  outline: 0;
  margin: 0;
  height: auto;
  padding: 12px 16px;
  font-size: 1rem;
  box-sizing: border-box;
  background-color: transparent;
  ${(props) => (props.$size ? `font-size:${props.$size};` : ``)};
  ${(props) => (props.$color ? `color:${props.$color};` : ``)};
  resize: none;
  &::placeholder {
    font-style: italic;
  }
  &:focus {
    background-color: transparent;
  }
  &:disabled {
  }
`;
// 0 0 16 10
const eyeOpened = (
  <svg
    width="14"
    height="10"
    viewBox="0 0 16 10"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M8 0C1.3 0 0 5.1 0 5.1C0 5.1 2.2 9.2 7.9 9.2C13.6 9.2 16 5.2 16 5.2C16 5.2 14.7 0 8 0ZM5.3 1.5C5.8 1.2 6.6 1.2 6.6 1.2C6.6 1.2 6.1 2.1 6.1 2.8C6.1 3.5 6.3 3.9 6.3 3.9L5.2 4.1C5.2 4.1 4.9 3.6 4.9 2.9C4.9 2.1 5.3 1.5 5.3 1.5ZM7.9 8.2C3.8 8.2 1.7 5.9 1.1 5C1.4 4.3 2.2 2.8 4.2 1.8C4.1 2.2 4 2.6 4 3.1C4 5.3 5.8 7.1 8 7.1C10.2 7.1 12 5.3 12 3.1C12 2.6 11.9 2.2 11.8 1.8C13.8 2.7 14.6 4.3 14.9 5C14.2 5.9 12.1 8.2 7.9 8.2Z"
      fill="#1C2E45"
      fillOpacity="0.6"
    />
  </svg>
);

const eyeClosed = (
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M16.9 9.19995L16.1 9.99995C17.8 10.9 18.6 12.3 18.9 13C18.2 13.9 16.1 16.1 11.9 16.1C11.2 16.1 10.7 16 10.1 15.9L9.29999 16.7C10.1 17 11 17.1 11.9 17.1C17.6 17.1 20 13.1 20 13.1C20 13.1 19.4 10.7 16.9 9.19995Z"
      fill="#1C2E45"
      fillOpacity="0.6"
    />
    <path
      d="M16 11.1C16 10.8 16 10.5 15.9 10.3L11.1 15C11.4 15 11.7 15.1 12 15.1C14.2 15.1 16 13.3 16 11.1Z"
      fill="#1C2E45"
      fillOpacity="0.6"
    />
    <path
      d="M19.3 4L14.9 8.4C14.1 8.2 13.1 8 12 8C5.3 8 4 13.1 4 13.1C4 13.1 5 14.9 7.3 16.1L4 19.3V20H4.7L20 4.7V4H19.3V4ZM8 15.3C6.4 14.6 5.5 13.5 5.1 13C5.4 12.3 6.2 10.8 8.2 9.8C8.1 10.2 8 10.6 8 11.1C8 12.2 8.5 13.3 9.3 14L8 15.3ZM10.2 11.9L9.2 12.1C9.2 12.1 8.9 11.6 8.9 10.9C8.9 10.1 9.3 9.4 9.3 9.4C9.8 9.1 10.6 9.1 10.6 9.1C10.6 9.1 10.1 10 10.1 10.8C10 11.5 10.2 11.9 10.2 11.9Z"
      fill="#1C2E45"
      fillOpacity="0.6"
    />
  </svg>
);

export const InputEl = styled.input<{
  $size?: string;
  $color?: string;
  $sx?: React.CSSProperties;
  $readOnly?: boolean;
}>`
  width: calc(100%);
  display: block;
  border: none;
  box-sizing: border-box;
  background-color: transparent;
  ${createCSSFromObject(InputFontStyle())}
  ${(props) => (props.$size ? `font-size:${props.$size};` : `1rem`)};
  ${(props) => (props.$color ? `color:${props.$color};` : ``)};
  ${(props) => createCSSFromObject(props.$sx ?? {})}
  ${(props) => props.$readOnly && `pointer-events: none; cursor: default;`}
	&::placeholder {
    /* font-style: italic; */
  }
  &:focus {
    /* background-color: transparent; */
    ${(props) => props.$sx?.backgroundColor ?? "background-color: transparent;"}
  }
  &:disabled {
  }
`;

const Input = ({
  disableAutocomplete,
  multiline,
  disable,
  readOnly,
  subtitle,
  type,
  label,
  data,
  name,
  iconRight,
  iconLeft,
  placeholder,
  onChange,
  sx,
  sxInput,
  size,
  inputColor,
  maxLength,
  isCard,
  onFocusProps,
  onBloorProps,
}: IInputProps) => {
  const theme = useTheme() as ITheme;
  const [value, setValue] = useState<string>(data[name] + "");
  const [focused, setFocused] = useState<boolean>(false);
  const [showPasswd, setShowPasswd] = useState<boolean>(false);

  const handleOnChange = (
    e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    data[name] = e.target.value;
    if (onChange) onChange(e.target.value);

    const filteredValue = isCard
      ? e.target.value
          .replace(/[^\dA-Z]/g, "")
          .replace(/(.{4})/g, "$1 ")
          .trim()
      : e.target.value;

    setValue(filteredValue);
  };

  const onFocus = () => {
    onFocusProps && onFocusProps();
    setFocused(true);
  };

  const onBlur = () => {
    onBloorProps && onBloorProps();
    setFocused(false);
  };

  const correctInput = (event: any) => {
    var target = event.target,
      value = target.value,
      key = event.key,
      typeKey,
      monthMin = "01",
      monthMax = "12",
      delimiter = "/",
      yearMin = new Date().getFullYear() - 2000,
      yearMax = new Date().getFullYear() - 2000 + 25;

    if (/(\d|ArrowLeft|ArrowRight|Backspace|Delete|Tab)/.test(key)) {
      if (/(\d)/.test(key)) {
        typeKey = "number";
      } else {
        typeKey = "specSymbol";
      }

      if (value.length == 0 && key > 1) {
        // 2 -> 02/
        target.value = "0" + key + delimiter;
        event.preventDefault();
      }

      if (value.length == 1 && value[0] != "0" && key > 2) {
        // 16 -> 12/
        target.value = monthMax + delimiter;
        event.preventDefault();
        return;
      }

      if (value.length == 1 && typeKey != "specSymbol") {
        //12 backspace -> 1
        target.value = target.value + key + delimiter;
        event.preventDefault();
      }

      if (value.length == 2 && typeKey != "specSymbol") {
        // 2 -> 02/
        target.value = target.value + delimiter + key;
        event.preventDefault();
        return;
      }

      if (value == "0" && key == "0") {
        // 00 -> 01
        target.value = monthMin + delimiter;
        event.preventDefault();
        return;
      }

      if (target.value.length + 1 == maxLength) {
        // 12/11 -> 12/16
        var arr = target.value.split("/");

        if (arr[0].length == 2 && arr[1] + key < yearMin) {
          target.value = arr[0] + delimiter + yearMin;
          event.preventDefault();
          return;
        }

        if (arr[0].length == 2 && arr[1] + key > yearMax) {
          // 12/55 -> 12/41
          target.value = arr[0] + delimiter + yearMax;
          event.preventDefault();
          return;
        }
      }
    } else {
      event.preventDefault();
      return;
    }
  };

  if (!inputColor) inputColor = theme.colors.textPrimary;

  if (!iconRight && type === "password")
    iconRight = (
      <Box
        onClick={() => {
          setShowPasswd(!showPasswd);
        }}
        sx={{
          padding: "5px 15px 5px 5px",
          cursor: "pointer",
          width: "40px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {!showPasswd ? eyeOpened : eyeClosed}
      </Box>
    );

  let inputElement = null;
  if (multiline || type === "textarea")
    inputElement = (
      <TextAreaEl
        maxLength={maxLength ? maxLength : undefined}
        disabled={disable}
        readOnly={readOnly}
        $color={inputColor}
        onFocus={onFocus}
        onBlur={onBlur}
        autoComplete={disableAutocomplete ? "off" : ""}
        placeholder={placeholder}
        $size={size}
        onChange={handleOnChange}
        value={value}
      />
    );

  let finalType = type;
  if (type === "password" && showPasswd) finalType = "text";

  let dateValue = "";
  if (type === "text") {
    if ((value as any) instanceof Date) {
      finalType = "date" as any;
      dateValue = (value as any).toISOString().split("T")[0];
    } else {
      // check to date
      try {
        let val = new Date(value).toISOString();
        if (val === value) {
          finalType = "date" as any;
          dateValue = new Date(value).toISOString().split("T")[0];
        }
      } catch (e) {}
    }
  }

  if (!inputElement)
    inputElement = (
      <InputEl
        onKeyDown={(e) => (type === "dateInput" ? correctInput(e) : {})}
        maxLength={maxLength ? maxLength : undefined}
        disabled={disable}
        $readOnly={readOnly}
        $sx={sxInput}
        $color={inputColor}
        type={finalType}
        onFocus={onFocus}
        onBlur={onBlur}

        name={disableAutocomplete ? "new-password" : ""}
        id={disableAutocomplete ? "new-password" : ""}
       

        autoComplete={disableAutocomplete ? "new-password" : ""}
        placeholder={placeholder}
        $size={size}
        onChange={handleOnChange}
        value={finalType === "date" ? dateValue : value}
      />
    );

  let predefinedSelector = null;

  if (type === "phone") {
    predefinedSelector = (
      <Select
        values={[
          { name: "Mobile", value: "mobile" },
          { name: "Mobile", value: "mobile" },
          { name: "Mobile", value: "mobile" },
          { name: "Mobile", value: "mobile" },
        ]}
      />
    );
  }

  const inputFieldContent = (
    <Box
      sx={{
        flexGrow: 1,
        boxSizing: "border-box",
        overflow: "hidden",
        display: "flex",

        ...InputBoxStyle(disable ?? false, readOnly ?? false),

        "&:hover": {
          //backgroundColor:"#e6e3dd", //F0EEEA
          border: disable || readOnly ? undefined : "1px solid #1a5bff",
          transition: "border .2s",
        },

        "@media (prefers-color-scheme: dark)": {
          //backgroundColor:"#29272f",
        },

        ...sx,

        ...(focused ? { border: "1px solid #1a5bff" } : {}),
      }}
    >
      {iconLeft}
      {inputElement}
      {iconRight}
    </Box>
  );

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: "3px",
      }}
    >
      {label && <Typo variant="caption">{label}:</Typo>}

      {predefinedSelector ? (
        <HBox gap="5px">
          {predefinedSelector}
          {inputFieldContent}
        </HBox>
      ) : (
        inputFieldContent
      )}

      {subtitle && (
        <Typo variant="small" sx={{ opacity: 0.7 }}>
          {subtitle}
        </Typo>
      )}
    </Box>
  );
};

export default Input;
