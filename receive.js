let peer = null;
let conn = null;
let aesKey = null;
let aesIv = null;

const connectForm = document.getElementById('connectForm');
const pingInput = document.getElementById('pingInput');
const connectionStatus = document.getElementById('connectionStatus');
const fileCard = document.getElementById('fileCard');
const receiveStatus = document.getElementById('receiveStatus');
const receivedFiles = document.getElementById('receivedFiles');

let incomingFile = null;
let receivedChunks = [];
let receivedSize = 0;
let progressDiv = null;
let progressBar = null;
let bar = null;
let fileReceived = false;
let readyForFiles = false;
let pendingChunks = [];

function setupPeer() {
    peer = new Peer({
        host: '0.peerjs.com',
        port: 443,
        secure: true,
        debug: 3
    });
    peer.on('open', (id) => {
        connectionStatus.innerHTML = '<span class="dot connected"></span> Connected';
        connectionStatus.classList.add('connected');
        fileCard.style.display = 'block';
        receiveStatus.textContent = 'Waiting for files...';
        
        // Move connection logic inside the open callback
        const senderId = pingInput.value.trim();
        if (senderId) {
            conn = peer.connect(senderId);
            conn.on('data', async (data) => {
                console.log('Received data:', data, typeof data, data instanceof ArrayBuffer, data instanceof Object);
                // If data is a string, try to parse as JSON
                if (typeof data === 'string') {
                    console.log('[RECV] Raw string message:', data);
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed && parsed.type) {
                            data = parsed;
                        }
                    } catch (e) {
                        // Not JSON, ignore
                        console.error('Failed to parse string data as JSON:', data);
                        return;
                    }
                }
                // If data is ArrayBuffer, buffer until both key and metadata are set
                if (data instanceof ArrayBuffer) {
                    pendingChunks.push(data);
                    console.warn('Chunk buffered until AES key and metadata are set.');
                    await tryProcessPendingChunks();
                    return;
                }
                if (!readyForFiles) {
                    if (data.type === 'aes-key') {
                        aesKey = await importAesKey(data.key);
                        aesIv = new Uint8Array(data.iv);
                        readyForFiles = true;
                        console.log('[KEY] AES key and IV set:', aesKey, aesIv, 'Type:', typeof aesKey);
                        await tryProcessPendingChunks();
                    }
                    return;
                }
                if (data.type === 'metadata') {
                    incomingFile = {
                        name: data.name,
                        size: data.size,
                        mime: data.mime
                    };
                    receivedChunks = [];
                    receivedSize = 0;
                    receiveStatus.textContent = `Receiving: ${incomingFile.name} (${Math.round(incomingFile.size/1024)} KB)`;
                    progressDiv = document.createElement('div');
                    progressDiv.textContent = 'Receiving: 0%';
                    progressBar = document.createElement('div');
                    progressBar.className = 'progress-container';
                    bar = document.createElement('div');
                    bar.className = 'progress-bar';
                    progressBar.appendChild(bar);
                    receivedFiles.appendChild(progressDiv);
                    receivedFiles.appendChild(progressBar);
                    fileReceived = false;
                    console.log('[META] Metadata received:', incomingFile, 'Type:', typeof incomingFile);
                    await tryProcessPendingChunks();
                } else if (data.type === 'done') {
                    try {
                        console.log('All chunks received, reconstructing file...');
                        const blob = new Blob(receivedChunks, { type: incomingFile.mime });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = incomingFile.name;
                        a.textContent = `Download ${incomingFile.name}`;
                        a.className = 'btn btn-white btn-small';
                        receivedFiles.appendChild(a);
                        progressDiv.textContent = `File received! (${incomingFile.name})`;
                        if (bar) bar.style.width = '100%';
                        receiveStatus.textContent = 'File ready to download.';
                        // Reset for next file
                        incomingFile = null;
                        receivedChunks = [];
                        receivedSize = 0;
                        fileReceived = true;
                        console.log('File reconstructed and download link created.');
                    } catch (err) {
                        console.error('File reconstruction error:', err);
                    }
                }
            });
            conn.on('error', (err) => {
                if (!fileReceived) {
                    connectionStatus.innerHTML = '<span class="dot"></span> Connection failed';
                    connectionStatus.classList.remove('connected');
                    connectionStatus.classList.add('waiting');
                    fileCard.style.display = 'none';
                    alert('Connection failed: ' + err);
                } else {
                    connectionStatus.innerHTML = '<span class="dot"></span> Connection closed after transfer';
                }
            });
        }
    });
}

// Import AES key from raw
async function importAesKey(rawKey) {
    return await window.crypto.subtle.importKey(
        'raw',
        new Uint8Array(rawKey),
        { name: 'AES-GCM' },
        true,
        ['encrypt', 'decrypt']
    );
}

// Decrypt data with AES-GCM
async function decryptData(data) {
    let arr = data;
    if (Array.isArray(data)) {
        arr = new Uint8Array(data);
    } else if (data instanceof ArrayBuffer) {
        arr = new Uint8Array(data);
    }
    return new Uint8Array(await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: aesIv },
        aesKey,
        arr
    ));
}

async function processChunk(data) {
    try {
        const decrypted = await decryptData(data);
        receivedChunks.push(decrypted);
        receivedSize += decrypted.byteLength;
        if (incomingFile && progressDiv && bar) {
            const percent = Math.min(100, Math.round((receivedSize / incomingFile.size) * 100));
            progressDiv.textContent = `Receiving: ${percent}% (${incomingFile.name})`;
            bar.style.width = percent + '%';
        }
        console.log('Decrypted chunk:', decrypted);
    } catch (err) {
        console.error('Decryption error:', err);
    }
}

async function tryProcessPendingChunks() {
    console.log('[tryProcessPendingChunks] Buffer length:', pendingChunks.length, 'aesKey:', !!aesKey, 'incomingFile:', !!incomingFile);
    if (aesKey && incomingFile) {
        let idx = 0;
        while (pendingChunks.length > 0) {
            const chunk = pendingChunks.shift();
            console.log(`[tryProcessPendingChunks] Processing buffered chunk #${idx}`);
            await processChunk(chunk);
            idx++;
        }
    }
}

connectForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const senderId = pingInput.value.trim();
    if (!senderId) return;
    setupPeer();
}); 
