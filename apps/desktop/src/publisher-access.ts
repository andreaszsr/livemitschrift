/** Credentials are sent only after choosing an exact HTTPS or loopback origin. */
export function publisherServer(server: string): URL {
    const base=new URL(server);
    const local=['localhost','127.0.0.1','[::1]'].includes(base.hostname);
    if (!(base.protocol==='https:' || (base.protocol==='http:' && local)) || base.username || base.password || base.pathname!=='/' || base.search || base.hash)
        throw new Error('Bitte HTTPS verwenden. HTTP ist nur mit localhost, 127.0.0.1 oder [::1] für lokale Tests erlaubt.');
    return base;
}
export function publisherKey(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Bitte den persönlichen Zugangsschlüssel mit 64 Hex-Zeichen eintragen.');
    return key;
}
export function accessError(code: number): string | null {
    if (code===4401) return 'Zugangsschlüssel fehlt, ist ungültig oder wurde widerrufen. Bitte unter Teilen prüfen.';
    if (code===4403) return 'Dieses Notizbuch gehört auf dem Server einer anderen Person. Bitte mit dem eigenen Zugangsschlüssel teilen oder den Administrator fragen.';
    if (code===4413) return 'Ihr Kontingent an Notizbüchern auf dem Server ist erreicht. Bitte ein altes Notizbuch vom Server entfernen oder den Administrator fragen.';
    if (code===4429) return 'Zu viele fehlgeschlagene Anmeldeversuche. Bitte kurz warten und den Schlüssel prüfen.';
    if (code===4426) return 'Der Server verlangt eine verschlüsselte HTTPS/WSS-Verbindung.';
    if (code===4503) return 'Veröffentlichen ist am Server gesperrt. Bitte den Zugangsschlüssel in der Server-Konfiguration setzen.';
    return null;
}

/** Read identity of a notebook on the server: SHA-256 of its private publishing secret. */
export async function notebookIdentity(secret: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Remove a notebook from the server (owner or administrator). Unknown notebooks count as removed. */
export async function withdrawFromServer(server: string, key: string, secret: string): Promise<void> {
    const base = publisherServer(server);
    const response = await fetch(new URL(`/api/notebook/${await notebookIdentity(secret)}`, base), {method: 'DELETE', redirect: 'error', headers: {'X-LiveMitschrift-Publisher-Key': publisherKey(key)}});
    if (response.status === 204 || response.status === 404) return;
    if (response.status === 403) throw new Error('Der Server lehnt das Entfernen ab: Das Notizbuch gehört einer anderen Person.');
    if (response.status === 401) throw new Error('Der Server lehnt das Entfernen ab: Zugangsschlüssel ungültig.');
    throw new Error(`Entfernen vom Server fehlgeschlagen (${response.status}).`);
}
