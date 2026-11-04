"use client";

// Loaded here (not in the root layout) so only meeting rooms pay for Excalidraw's CSS.
import "@excalidraw/excalidraw/index.css";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import { LoadingBlock } from "@/components/shared/loading-block";

const ExcalidrawCanvas = dynamic(
  () => import("@excalidraw/excalidraw").then((mod) => mod.Excalidraw),
  {
    ssr: false,
    loading: () => <LoadingBlock className="h-full w-full rounded-[24px]" />,
  },
);

const WHITEBOARD_SAVE_DEBOUNCE_MS = 800;
let serializeAsJSONPromise: Promise<
  typeof import("@excalidraw/excalidraw")["serializeAsJSON"]
> | null = null;

async function serializeScene(
  elements: Parameters<NonNullable<ExcalidrawProps["onChange"]>>[0],
  appState: AppState,
  files: BinaryFiles,
) {
  if (!serializeAsJSONPromise) {
    serializeAsJSONPromise = import("@excalidraw/excalidraw").then(
      (mod) => mod.serializeAsJSON,
    );
  }

  const serializeAsJSON = await serializeAsJSONPromise;
  return serializeAsJSON(elements, appState, files, "database");
}

function parseInitialScene(
  serializedScene: string | null | undefined,
): ExcalidrawInitialDataState | null {
  if (!serializedScene) {
    return {
      appState: {
        viewBackgroundColor: "#ffffff",
      },
    };
  }

  try {
    return JSON.parse(serializedScene) as ExcalidrawInitialDataState;
  } catch {
    return {
      appState: {
        viewBackgroundColor: "#ffffff",
      },
    };
  }
}

export function MeetingWhiteboard({
  meetingId,
  canEdit,
  serializedScene,
  onSaveScene,
}: {
  meetingId: string;
  canEdit: boolean;
  serializedScene: string | null | undefined;
  onSaveScene: (scene: string) => Promise<void>;
}) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const initialData = useMemo(
    () => parseInitialScene(serializedScene),
    [serializedScene],
  );
  const saveTimerRef = useRef<number | null>(null);
  const lastRemoteSceneRef = useRef<string | null>(serializedScene ?? null);
  const lastQueuedSceneRef = useRef<string | null>(serializedScene ?? null);
  const isApplyingRemoteSceneRef = useRef(false);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!api) {
      lastRemoteSceneRef.current = serializedScene ?? null;
      lastQueuedSceneRef.current = serializedScene ?? null;
      return;
    }

    const nextSerializedScene = serializedScene ?? null;
    if (
      nextSerializedScene === null ||
      nextSerializedScene === lastRemoteSceneRef.current ||
      nextSerializedScene === lastQueuedSceneRef.current
    ) {
      lastRemoteSceneRef.current = nextSerializedScene;
      return;
    }

    const parsed = parseInitialScene(nextSerializedScene);
    if (!parsed) {
      return;
    }

    isApplyingRemoteSceneRef.current = true;
    api.updateScene({
      elements: parsed.elements ?? [],
      appState: {
        viewBackgroundColor: parsed.appState?.viewBackgroundColor ?? "#ffffff",
      },
    });
    lastRemoteSceneRef.current = nextSerializedScene;
    lastQueuedSceneRef.current = nextSerializedScene;
    window.setTimeout(() => {
      isApplyingRemoteSceneRef.current = false;
    }, 0);
  }, [api, serializedScene]);

  const handleChange: NonNullable<ExcalidrawProps["onChange"]> = (
    elements,
    appState: AppState,
    files: BinaryFiles,
  ) => {
    if (!canEdit || isApplyingRemoteSceneRef.current) {
      return;
    }

    void serializeScene(elements, appState, files).then((nextScene) => {
      if (nextScene === lastQueuedSceneRef.current) {
        return;
      }

      lastQueuedSceneRef.current = nextScene;

      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = window.setTimeout(() => {
        void onSaveScene(nextScene);
      }, WHITEBOARD_SAVE_DEBOUNCE_MS);
    });
  };

  return (
    <div className="h-full w-full bg-white">
      <ExcalidrawCanvas
        excalidrawAPI={setApi}
        initialData={initialData}
        onChange={handleChange}
        gridModeEnabled
        viewModeEnabled={!canEdit}
        theme="light"
        name={`${meetingId}-whiteboard`}
        UIOptions={{
          canvasActions: {
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            saveAsImage: false,
            toggleTheme: false,
          },
          tools: {
            image: false,
          },
        }}
      />
    </div>
  );
}
