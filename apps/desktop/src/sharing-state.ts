export interface SharingState {
    phase: "off" | "connecting" | "live" | "reconnecting" | "error";
    viewerUrl: string | null;
    detail?: string;
}
