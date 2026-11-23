import { ITheme, TTypoVariant } from "../theme/GlobalTheme";
import { Box } from "../box/Box";
import { useTheme } from "styled-components";
import { forwardRef } from "react";

export interface ITypoProps {
  block?: boolean;
  children?: any;
  variant?: TTypoVariant;
  sx?: React.CSSProperties & { [key: string]: any };
  capitalize?: boolean;
  uppercase?: boolean;
  italic?: boolean;
  align?: string;
  weight?: string;
  color?: string;
  bold?: boolean;
  inline?: boolean;
  onClick?: (e: any) => void;
}

export const Typo = forwardRef(
  (
    {
      onClick,
      bold,
      italic,
      children,
      variant,
      sx,
      block,
      capitalize,
      uppercase,
      align,
      weight,
      color,
      inline,
    }: ITypoProps,
    ref
  ) => {
    const theme = useTheme() as ITheme;
    if (variant && theme && theme.typo) {
      const css: { [key: string]: string | number | boolean } =
        theme.typo[variant];
      if (css) {
        for (let i in css) {
          const val = css[i];
          if ((val + "").startsWith("--")) {
            const tval = (val + "").substring(2);
            if (tval in theme.colors)
              css[i] = (
                theme.colors as unknown as {
                  [key: string]: string | number | boolean;
                }
              )[tval];
          }
        }
        sx = { ...css, ...sx };
      }
    }

    const tsx = { ...sx };

    if (block) {
      tsx.display = "block";
      tsx.textOverflow = "ellipsis";
      tsx.overflow = "hidden";
    }

    if (align) tsx.textAlign = align as any;

    if (weight) tsx.fontWeight = weight as any;

    if (color) tsx.color = color as any;

    if (capitalize) tsx.textTransform = "capitalize";

    if (uppercase) tsx.textTransform = "uppercase";

    if (italic) tsx.fontStyle = "italic";

    if (bold) tsx.fontWeight = "700";

    if (inline) tsx.display = "inline-block";

    return (
      <Box onClick={onClick} sx={tsx} ref={ref}>
        {children}
      </Box>
    );
  }
);

export const TypoHead = (props: ITypoProps) => {
  let tsx = props.sx;
  if (!tsx) tsx = {};
  tsx.fontSize = "1.2em";
  tsx.fontWeight = "700";
  tsx = { ...props.sx, ...tsx };
  return <Typo {...props} sx={tsx} />;
};

export const TypoHeadMid = (props: ITypoProps) => {
  let tsx = props.sx;
  if (!tsx) tsx = {};
  tsx.fontSize = "1.1em";
  tsx = { ...props.sx, ...tsx };
  return <Typo {...props} sx={tsx} />;
};

export const TypoMid = (props: ITypoProps) => {
  let tsx = props.sx;
  if (!tsx) tsx = {};
  tsx.fontSize = "13px";
  tsx = { ...props.sx, ...tsx };
  return <Typo {...props} sx={tsx} />;
};

export const TypoHeadSmall = (props: ITypoProps) => {
  let tsx = props.sx;
  if (!tsx) tsx = {};
  if (!tsx.fontSize) tsx.fontSize = "1.1em";
  if (!tsx.fontWeight) tsx.fontWeight = "600";
  tsx = { ...props.sx, ...tsx };
  return <Typo {...props} sx={tsx} />;
};

export const TypoHeadBig = (props: ITypoProps) => {
  let tsx = props.sx;
  if (!tsx) tsx = {};
  tsx.fontSize = "1.6em";
  tsx.fontWeight = "700";
  tsx = { ...props.sx, ...tsx };
  return <Typo {...props} sx={tsx} />;
};

export const TypoSmall = (props: ITypoProps) => {
  let tsx = props.sx;
  if (!tsx) tsx = {};

  tsx.fontSize = "11px";
  tsx = { ...props.sx, ...tsx };
  return <Typo {...props} sx={tsx} />;
};

export const TypoCaption = (props: ITypoProps) => {
  let tsx = props.sx;

  if (!tsx) tsx = {};
  tsx.fontSize = "12px";
  tsx.color = "#465264";
  if (props.color) tsx.color = props.color;

  tsx = {
    ...tsx,
    "@media (prefers-color-scheme: dark)": {
      //color:"#a3afc1",
    },
  };

  tsx = { ...tsx, ...props.sx };
  return <Typo {...props} sx={tsx} />;
};

export const TypoMedium = (props: ITypoProps) => {
  let tsx = props.sx;
  if (!tsx) tsx = {};
  tsx.fontSize = "14px";
  tsx = { ...props.sx, ...tsx };
  return <Typo {...props} sx={tsx} />;
};

export const TypoError = (props: ITypoProps) => {
  return (
    <Typo {...props} sx={{ fontSize: "13px", color: "#8a0037", ...props.sx }} />
  );
};

export const TypoInfo = (props: ITypoProps) => {
  return (
    <Typo {...props} sx={{ fontSize: "13px", color: "#001489", ...props.sx }} />
  );
};

export const TypoHuge = (props: ITypoProps) => {
  return (
    <Typo
      {...props}
      sx={{
        fontSize: "32px",
        fontStyle: "italic",
        color: "#6D7690",
        fontWeight: "600",
        textTransform: "uppercase",
        ...props.sx,
      }}
    />
  );
};
