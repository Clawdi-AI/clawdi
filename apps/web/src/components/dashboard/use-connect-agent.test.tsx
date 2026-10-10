import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useConnectAgent } from "@/components/dashboard/use-connect-agent";

test("server render takes the browser path without reading window", () => {
	function Probe() {
		const { connect, dialog } = useConnectAgent();
		return (
			<>
				<button type="button" onClick={connect}>
					Connect
				</button>
				{dialog}
			</>
		);
	}

	expect(typeof window).toBe("undefined");
	expect(renderToStaticMarkup(<Probe />)).toBe('<button type="button">Connect</button>');
});
