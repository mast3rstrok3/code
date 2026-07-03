import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MediaPreviewSurface, mediaElementErrorMessage } from "./MediaPreviewSurface";

describe("MediaPreviewSurface", () => {
  it("renders video controls with an explicit WebM source type", () => {
    const html = renderToStaticMarkup(
      <MediaPreviewSurface
        kind="video"
        name="recording.webm"
        url="/api/assets/token/recording.webm"
        mediaClassName="video-preview"
      />,
    );

    expect(html).toContain("<video");
    expect(html).toContain("controls");
    expect(html).toContain('preload="metadata"');
    expect(html).toContain('type="video/webm"');
    expect(html).toContain('class="video-preview"');
    expect(html).not.toContain("Open raw");
  });

  it("renders open and download fallbacks for video load errors", () => {
    const html = renderToStaticMarkup(
      <MediaPreviewSurface
        kind="video"
        name="logs/recordings/page@abcd.webm"
        url="/api/assets/token/page%40abcd.webm"
        errorMessage={mediaElementErrorMessage("video")}
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain("Unable to load video preview.");
    expect(html).toContain("Retry");
    expect(html).toContain("Open raw");
    expect(html).toContain("Download");
    expect(html).toContain('href="/api/assets/token/page%40abcd.webm"');
    expect(html).toContain('download="page@abcd.webm"');
  });
});
