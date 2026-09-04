/**
 * Pure SDP surgery for the stereo negotiation — the exact recipe the Java client proved
 * against this Janus build (round-3 research): munge "stereo=1" into a=fmtp:<opusPT> of
 * the share-audio m-line in the publisher OFFER; Janus echoes it in its answer AND in
 * the offers it sends subscribers, and marks the stream "stereo":true.
 *
 * Locating the share-audio m-line: primary = the m=audio section whose a=msid contains
 * the share audio track id (in Chromium the offer's msid carries the track id). Fallback
 * = the m=audio section with the HIGHEST m-line index — the publisher's addTrack order
 * is [mic audio, screen video, share audio], so share audio is always the LAST m=audio.
 */

export interface AudioFmtpLine {
  mindex: number;
  mid: string | null;
  fmtp: string | undefined;
}

/**
 * The a=mid of EVERY m= section, in SDP order — the m-line SLOT contract resolved
 * through the actual SDP. Indexing the PC's transceiver ARRAY is fragile: on SRD an
 * offer Chromium may refuse to reuse our pre-created EMPTY transceivers and add its
 * own (live M5 smoke: ontrack arrived on array slots 3/4, our senders were dead).
 * The mids inside the negotiated SDP are the only stable identity.
 */
export function sectionMids(sdp: string): (string | null)[] {
  return splitSections(sdp)
    .filter((section) => section.startsWith("m="))
    .map((section) => section.match(/^a=mid:([^\r\n]*)/m)?.[1] ?? null);
}

function splitSections(sdp: string): string[] {
  return sdp.split(/(?=m=)/);
}

function headerValue(section: string, header: string): string | null {
  const match = section.match(new RegExp(`^${header}:([^\\r\\n]*)`, "m"));
  return match ? match[1]! : null;
}

/** Every m=audio section with its (mindex, mid, fmtp) — the diagnostics readout. */
export function extractAudioFmtpLines(sdp: string): AudioFmtpLine[] {
  const sections = splitSections(sdp);
  const audioLines: AudioFmtpLine[] = [];
  let mindex = -1;
  for (const section of sections) {
    if (!section.startsWith("m=")) {
      continue;
    }
    mindex += 1;
    if (!section.startsWith("m=audio")) {
      continue;
    }
    const midMatch = section.match(/^a=mid:([^\r\n]*)/m);
    const fmtpMatch = section.match(/^a=fmtp:(\d+) ([^\r\n]*)/m);
    audioLines.push({
      mindex,
      mid: midMatch ? midMatch[1]! : null,
      fmtp: fmtpMatch ? fmtpMatch[2]! : undefined,
    });
  }
  return audioLines;
}

/** Payload type of the opus codec in an m=audio section (114/111 typically). */
function opusPayloadType(section: string): string | null {
  const match = section.match(/^a=rtpmap:(\d+) opus\/48000\/2/m);
  return match ? match[1]! : null;
}

function sectionIndexOfShareAudio(sdp: string, shareTrackId: string): number {
  const sections = splitSections(sdp);
  let audioSectionIndex = -1;
  let lastAudioSectionIndex = -1;
  let currentIndex = -1;
  for (const section of sections) {
    if (!section.startsWith("m=")) {
      continue;
    }
    currentIndex += 1;
    if (!section.startsWith("m=audio")) {
      continue;
    }
    audioSectionIndex += 1;
    lastAudioSectionIndex = currentIndex;
    const msid = headerValue(section, "a=msid");
    // msid carries TWO tokens (stream id + track id); either may match the track id.
    if (msid && msid.split(/\s+/).some((token) => token === shareTrackId)) {
      return currentIndex;
    }
  }
  return lastAudioSectionIndex; // fallback: share audio is the LAST m=audio section
}

function appendStereoToFmtp(section: string): string {
  const payloadType = opusPayloadType(section);
  if (payloadType === null) {
    return section;
  }
  const fmtpRegex = new RegExp(`^(a=fmtp:${payloadType} )([^\\r\\n]*)(.*)$`, "m");
  const match = section.match(fmtpRegex);
  if (!match) {
    // no fmtp line at all — insert one after the rtpmap (keep the section's line endings)
    const lineBreak = section.includes("\r\n") ? "\r\n" : "\n";
    return section.replace(
      new RegExp(`^(a=rtpmap:${payloadType} opus/48000/2)$`, "m"),
      `$1${lineBreak}a=fmtp:${payloadType} stereo=1`,
    );
  }
  const params = match[2]!;
  if (/(^|;)stereo=1(;|$)/.test(params)) {
    return section; // idempotent — Chromium may already have emitted it
  }
  const glued = params.endsWith(";") ? `${params}stereo=1` : `${params};stereo=1`;
  return section.replace(fmtpRegex, `$1${glued}$3`);
}

/** Munge "stereo=1" into the share-audio m-line of a publisher offer (before SLD). */
export function mungeStereoIntoOffer(sdp: string, shareTrackId: string): string {
  const sections = splitSections(sdp);
  const sectionIndex = sectionIndexOfShareAudio(sdp, shareTrackId);
  if (sectionIndex === -1) {
    return sdp;
  }
  let sectionCount = -1;
  const rewritten = sections.map((section) => {
    if (!section.startsWith("m=")) {
      return section;
    }
    sectionCount += 1;
    if (sectionCount === sectionIndex && section.startsWith("m=audio")) {
      return appendStereoToFmtp(section);
    }
    return section;
  });
  return rewritten.join("");
}

/**
 * Subscriber-side symmetry: keep "stereo=1" in OUR answer when Janus's offer has it on
 * the matching m=audio section (Chromium's answer generation can strip it).
 */
export function mungeStereoIntoAnswerIfOfferHasIt(answerSdp: string, offerSdp: string): string {
  const offerSections = splitSections(offerSdp);
  const offerAudioSections = offerSections.filter((section) => section.startsWith("m=audio"));
  const stereoByPosition = offerAudioSections.map((section) => {
    const fmtp = section.match(/^a=fmtp:\d+ ([^\r\n]*)/m)?.[1] ?? "";
    return /(^|;)stereo=1(;|$)/.test(fmtp);
  });

  const answerSections = splitSections(answerSdp);
  let audioPosition = -1;
  return answerSections
    .map((section) => {
      if (!section.startsWith("m=audio")) {
        return section;
      }
      audioPosition += 1;
      if (stereoByPosition[audioPosition] === true) {
        return appendStereoToFmtp(section);
      }
      return section;
    })
    .join("");
}
