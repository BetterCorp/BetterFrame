use crate::bundle::SmartUrlStep;

fn js_string(value: &str) -> String {
    serde_json::to_string(value).expect("strings serialize")
}

pub fn step_javascript(step: &SmartUrlStep) -> String {
    let selector = step
        .selector
        .as_deref()
        .map(js_string)
        .unwrap_or_else(|| "null".into());
    let action = match step.step_type.as_str() {
        "fill" => {
            let Some(value) = step.value.as_deref() else {
                return "return false;".into();
            };
            format!(
                r#"
                const el = findElement({selector});
                if (!el) return false;
                const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
                if (setter) setter.call(el, {value}); else el.value = {value};
                el.dispatchEvent(new Event('input', {{bubbles:true}}));
                el.dispatchEvent(new Event('change', {{bubbles:true}}));
                return true;
            "#,
                value = js_string(value)
            )
        }
        "click" => format!(
            "const el = findElement({selector}); if (!el) return false; el.click(); return true;"
        ),
        "wait" => format!(
            "await new Promise(resolve => setTimeout(resolve, {})); return true;",
            step.delay_ms.unwrap_or(1000)
        ),
        "wait_for" => format!(
            r#"
            const deadline = Date.now() + {};
            do {{
                if (findElement({selector})) return true;
                if (Date.now() >= deadline) return false;
                await new Promise(resolve => setTimeout(resolve, 100));
            }} while (true);
        "#,
            step.timeout_ms.unwrap_or(10000)
        ),
        "javascript" => format!(
            "await (async () => {{\n{}\n}})(); return true;",
            step.script.as_deref().unwrap_or("")
        ),
        _ => "return false;".into(),
    };
    format!(
        r#"
        function findElement(selector, root = document) {{
            const found = root.querySelector(selector);
            if (found) return found;
            for (const element of root.querySelectorAll('*')) {{
                if (element.shadowRoot) {{
                    const child = findElement(selector, element.shadowRoot);
                    if (child) return child;
                }}
            }}
            return null;
        }}
        {action}
    "#
    )
}
