"use client";

import { useEffect, useMemo, useState } from "react";

import {
  LiveKitRoom,
  VideoTrack,
  AudioTrack,
  useParticipants,
  useTracks,
  useLocalParticipant,
  useRoomContext,
  isTrackReference,
  type TrackReference,
} from "@livekit/components-react";

import { Track, type Participant } from "livekit-client";

import {
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  Monitor,
  PhoneOff,
  Users,
  X,
  Search,
  Check,
  Loader2,
  Headphones,
} from "lucide-react";

import { useAppStore } from "@/lib/store/app-store";
import { getSupabaseClient } from "@/lib/supabase/client";
import { ringProfile } from "@/lib/call-invites";
import type { Profile } from "@/types/database";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const AVATAR_COLORS = [
  "#7C5CFC",
  "#E01E5A",
  "#2BAC76",
  "#E8912D",
  "#1264A3",
  "#9C27B0",
  "#00B6C6",
  "#D1707B",
];

function colorForIdentity(identity: string): string {
  let hash = 0;
  for (let i = 0; i < identity.length; i++) {
    hash = (hash * 31 + identity.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

/* ------------------------------------------------------------------ */
/* Call leave cleanup                                                  */
/*                                                                     */
/* The active_calls row is what drives the "call in progress"          */
/* indicator for the whole workspace, so it MUST be ended when         */
/* the last participant leaves — otherwise the indicator (and          */
/* the ability to re-join) stays forever.                              */
/* ------------------------------------------------------------------ */

async function cleanupCallMembership() {
  const client = getSupabaseClient()

  const { activeCall, user } = useAppStore.getState()

  if (!client || !activeCall || !user) return

  try {
    // 1. Mark our own participant row as left
    await client
      .from('call_participants')
      .update({ left_at: new Date().toISOString() })
      .eq('call_id', activeCall.id)
      .eq('profile_id', user.id)
      .is('left_at', null)

    // 2. If no active participants remain, end the
    //    call for everyone.
    //    Participants whose profile is offline are
    //    treated as gone (handles crashed tabs and
    //    stale rows left by older versions).
    const { data: remaining } = await client
      .from('call_participants')
      .select('profile_id, profile:profiles(is_online)')
      .eq('call_id', activeCall.id)
      .is('left_at', null)

    const activeCount = (remaining ?? []).filter(
      (row) =>
        (row.profile as { is_online?: boolean } | null)
          ?.is_online === true
    ).length

    if (activeCount === 0) {
      await client
        .from('active_calls')
        .update({ ended_at: new Date().toISOString() })
        .eq('id', activeCall.id)
        .is('ended_at', null)
    }
  } catch (err) {
    console.error(
      'Failed to clean up call membership:',
      err
    )
  }
}

/* ------------------------------------------------------------------ */
/* CallPanel — outer shell (LiveKitRoom + connection)                  */
/* ------------------------------------------------------------------ */

export function CallPanel() {
  const {
    activeCall,
    callToken,
    callUrl,
    isInCall,
    startsWithVideo,
    leaveCall,
    channels,
  } = useAppStore();

  if (!isInCall || !activeCall || !callToken || !callUrl) {
    return null;
  }

  const channel = channels.find((c) => c.id === activeCall.channel_id);
  const channelLabel = channel?.name || "Call";
  const isVideoCall = activeCall.type === "video_call";

  return (
    <div
      className="fixed inset-0 z-[90] flex flex-col"
      style={{ background: "#16181D" }}
    >
      <LiveKitRoom
        serverUrl={callUrl}
        token={callToken}
        connect
        audio
        video={startsWithVideo}
        onDisconnected={() => {
          leaveCall();
          // Covers connection drops / refresh while in
          // the call — same DB cleanup as leaving.
          void cleanupCallMembership()
          leaveCall()
        }}
        options={{
          adaptiveStream: true,
          dynacast: true,
        }}
        style={{ width: "100%", height: "100%" }}
      >
        <CallContent channelLabel={channelLabel} isVideoCall={isVideoCall} />
      </LiveKitRoom>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Live call timer                                                     */
/* ------------------------------------------------------------------ */

function LiveTimer() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <span
      className="font-mono text-[12px]"
      style={{ color: "rgba(255,255,255,0.6)" }}
    >
      {formatDuration(seconds)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Participant tile                                                    */
/* ------------------------------------------------------------------ */

function ParticipantTile({
  participant,
  trackRef,
}: {
  participant: Participant;
  trackRef?: TrackReference;
}) {
  const name = participant.name || participant.identity;
  const identity = participant.identity;
  const hasCamera = participant.isCameraEnabled && !!trackRef;

  return (
    <div
      className="relative rounded-xl overflow-hidden transition-shadow"
      style={{
        background: "#15181E",
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow: participant.isSpeaking ? "0 0 0 2px #2BAC76" : "none",
      }}
    >
      {hasCamera ? (
        <VideoTrack
          trackRef={trackRef!}
          className="h-full w-full object-cover"
          style={participant.isLocal ? { transform: "scaleX(-1)" } : undefined}
        />
      ) : (
        <div
          className="h-full w-full flex items-center justify-center"
          style={{ minHeight: 180 }}
        >
          <div
            className="h-20 w-20 rounded-lg flex items-center justify-center text-white text-2xl font-bold"
            style={{ background: colorForIdentity(identity) }}
          >
            {initialsFor(name)}
          </div>
        </div>
      )}

      {/* Name overlay */}
      <div
        className="absolute bottom-2 left-2 right-2 flex items-center gap-1.5 px-2.5 py-1 rounded-lg w-fit max-w-full"
        style={{ background: "rgba(0,0,0,0.55)" }}
      >
        {!participant.isMicrophoneEnabled && (
          <MicOff className="h-3 w-3 shrink-0" style={{ color: "#E01E5A" }} />
        )}
        <span
          className="text-[12px] font-medium truncate"
          style={{ color: "#ffffff" }}
        >
          {name}
          {participant.isLocal ? " (You)" : ""}
        </span>
      </div>

      {/* Local-only badge */}
      {participant.isLocal && (
        <div
          className="absolute top-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-semibold"
          style={{
            background: "rgba(0,0,0,0.55)",
            color: "rgba(255,255,255,0.85)",
          }}
        >
          Local
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* CallContent — the in-call meeting room                              */
/* ------------------------------------------------------------------ */

function CallContent({
  channelLabel,
  isVideoCall,
}: {
  channelLabel: string;
  isVideoCall: boolean;
}) {
  const { user, leaveCall } = useAppStore();
  const room = useRoomContext();
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();

  const [peopleOpen, setPeopleOpen] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const isMuted = !localParticipant.isMicrophoneEnabled;
  const isCameraOn = localParticipant.isCameraEnabled;

  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: false },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
      { source: Track.Source.Microphone, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  const cameraTracks = useMemo(
    () =>
      tracks.filter(
        (t): t is TrackReference =>
          t.source === Track.Source.Camera && isTrackReference(t),
      ),
    [tracks],
  );
  const screenTracks = useMemo(
    () =>
      tracks.filter(
        (t): t is TrackReference =>
          t.source === Track.Source.ScreenShare && isTrackReference(t),
      ),
    [tracks],
  );
  const audioTracks = useMemo(
    () =>
      tracks.filter(
        (t): t is TrackReference =>
          t.source === Track.Source.Microphone && isTrackReference(t),
      ),
    [tracks],
  );

  // Track whether our screen share is active (to style the button)
  useEffect(() => {
    const mine = screenTracks.some((t) => t.participant.isLocal);
    setIsScreenSharing(mine);
  }, [screenTracks]);

  const cameraByParticipant = useMemo(() => {
    const map = new Map<string, TrackReference>();
    cameraTracks.forEach((ref) => {
      map.set(ref.participant.identity, ref);
    });
    return map;
  }, [cameraTracks]);

  // Remote-first, local last (like most meeting tools)
  const orderedParticipants = useMemo(() => {
    const remote = participants.filter((p) => !p.isLocal);
    const local = participants.filter((p) => p.isLocal);
    return [...remote, ...local];
  }, [participants]);

  async function toggleMute() {
    try {
      await localParticipant.setMicrophoneEnabled(isMuted);
    } catch (err) {
      console.error("Failed to toggle microphone:", err);
    }
  }

  async function toggleCamera() {
    try {
      await localParticipant.setCameraEnabled(!isCameraOn);
    } catch (err) {
      console.error("Failed to toggle camera:", err);
    }
  }

  async function toggleScreenShare() {
    try {
      await localParticipant.setScreenShareEnabled(!isScreenSharing);
    } catch (err) {
      console.error("Failed to toggle screen sharing:", err);
    }
  }

  async function handleLeave() {
    const { activeCall } = useAppStore.getState();
    // Persist "left" (and end the call when nobody
    // remains) BEFORE disconnecting, while the call
    // is still available in the store.
    await cleanupCallMembership()

    try {
      await room.disconnect();
    } catch {
      // ignore — connection may already be gone
    }

    if (activeCall && user) {
      const client = getSupabaseClient();
      if (client) {
        try {
          await client
            .from("call_participants")
            .update({ left_at: new Date().toISOString() })
            .eq("call_id", activeCall.id)
            .eq("profile_id", user.id);

          const { count } = await client
            .from("call_participants")
            .select("*", { count: "exact", head: true })
            .eq("call_id", activeCall.id)
            .is("left_at", null);

          if (!count) {
            await client
              .from("active_calls")
              .update({ ended_at: new Date().toISOString() })
              .eq("id", activeCall.id);
          }
        } catch {}
      }
    }

    leaveCall();
  }

  const spotlight = screenTracks.find((t) => isTrackReference(t));

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header */}
      <div
        className="shrink-0 flex items-center gap-3 px-5 h-14"
        style={{
          background: "#0F1115",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        <div
          className="h-7 w-7 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: isVideoCall ? "#7C5CFC" : "#2BAC76" }}
        >
          {isVideoCall ? (
            <VideoIcon className="h-4 w-4 text-white" />
          ) : (
            <Headphones className="h-4 w-4 text-white" />
          )}
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="text-[14px] font-semibold truncate"
              style={{ color: "#ffffff" }}
            >
              {channelLabel}
            </span>
            <span
              className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0"
              style={{
                background: isVideoCall
                  ? "rgba(124,92,252,0.18)"
                  : "rgba(43,172,118,0.15)",
                color: isVideoCall ? "#B49BFF" : "#5FD3A2",
              }}
            >
              {isVideoCall ? "Video call" : "Huddle"}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="h-1.5 w-1.5 rounded-full animate-pulse"
              style={{ background: "#E01E5A" }}
            />
            <span
              className="text-[11px]"
              style={{ color: "rgba(255,255,255,0.5)" }}
            >
              LIVE
            </span>
            <LiveTimer />
          </div>
        </div>

        <div className="flex-1" />

        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium"
          style={{
            background: "rgba(255,255,255,0.06)",
            color: "rgba(255,255,255,0.7)",
          }}
        >
          <Users className="h-3.5 w-3.5" />
          {participants.length}
        </div>
      </div>

      {/* Stage */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0 p-4 gap-3">
          {spotlight && (
            <div
              className="h-[45%] shrink-0 rounded-xl overflow-hidden"
              style={{ background: "#15181E" }}
            >
              <VideoTrack
                trackRef={spotlight}
                className="h-full w-full object-contain"
              />
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto">
            <div
              className="grid gap-3 content-start"
              style={{
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              }}
            >
              {orderedParticipants.map((participant) => (
                <ParticipantTile
                  key={participant.identity}
                  participant={participant}
                  trackRef={cameraByParticipant.get(participant.identity)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* People drawer */}
        {peopleOpen && (
          <PeopleDrawer
            channelId={useAppStore.getState().activeCall?.channel_id || ""}
            callId={useAppStore.getState().activeCall?.id || ""}
            isVideoCall={isVideoCall}
            callerName={user?.display_name || user?.id || "Someone"}
            participants={participants.map((p) => ({
              identity: p.identity,
              name: p.name || p.identity,
              isLocal: p.isLocal,
              muted: !p.isMicrophoneEnabled,
            }))}
            onClose={() => setPeopleOpen(false)}
          />
        )}
      </div>

      {/* Remote audio elements */}
      <div className="hidden">
        {audioTracks
          .filter((track) => !track.participant.isLocal)
          .map((track) => (
            <AudioTrack
              key={track.participant.sid + "-audio"}
              trackRef={track}
            />
          ))}
      </div>

      {/* Control bar */}
      <div
        className="shrink-0 flex items-center justify-center gap-3 px-6 py-4"
        style={{
          background: "#0F1115",
          borderTop: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        <ControlButton
          onClick={toggleMute}
          active={!isMuted}
          danger={isMuted}
          title={isMuted ? "Unmute" : "Mute"}
          icon={
            isMuted ? (
              <MicOff className="h-5 w-5" />
            ) : (
              <Mic className="h-5 w-5" />
            )
          }
        />

        <ControlButton
          onClick={toggleCamera}
          active={isCameraOn}
          title={isCameraOn ? "Turn off camera" : "Turn on camera"}
          icon={
            isCameraOn ? (
              <VideoIcon className="h-5 w-5" />
            ) : (
              <VideoOff className="h-5 w-5" />
            )
          }
        />

        <ControlButton
          onClick={toggleScreenShare}
          active={isScreenSharing}
          title={isScreenSharing ? "Stop sharing" : "Share screen"}
          icon={<Monitor className="h-5 w-5" />}
        />

        <ControlButton
          onClick={() => setPeopleOpen((open) => !open)}
          active={peopleOpen}
          title="People & invites"
          icon={<Users className="h-5 w-5" />}
        />

        <div
          className="w-px h-8 mx-1"
          style={{ background: "rgba(255,255,255,0.12)" }}
        />

        <button
          type="button"
          onClick={handleLeave}
          className="h-12 px-6 rounded-2xl flex items-center justify-center gap-2 hover:scale-105 transition-all text-white font-semibold text-sm"
          style={{ background: "#E01E5A" }}
          title="Leave call"
        >
          <PhoneOff className="h-5 w-5" />
          Leave
        </button>
      </div>
    </div>
  );
}

function ControlButton({
  onClick,
  active,
  danger,
  title,
  icon,
}: {
  onClick: () => void;
  active: boolean;
  danger?: boolean;
  title: string;
  icon: React.ReactNode;
}) {
  const background = danger
    ? "#E01E5A"
    : active
      ? "rgba(255,255,255,0.14)"
      : "rgba(255,255,255,0.08)";

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="h-12 w-12 rounded-2xl flex items-center justify-center hover:scale-105 transition-all"
      style={{ background, color: "#ffffff" }}
    >
      {icon}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* People drawer — participants + invite members                       */
/* ------------------------------------------------------------------ */

interface DrawerParticipant {
  identity: string;
  name: string;
  isLocal: boolean;
  muted: boolean;
}

type RingStatus = "idle" | "ringing" | "sent" | "failed";

function PeopleDrawer({
  channelId,
  callId,
  isVideoCall,
  callerName,
  participants,
  onClose,
}: {
  channelId: string;
  callId: string;
  isVideoCall: boolean;
  callerName: string;
  participants: DrawerParticipant[];
  onClose: () => void;
}) {
  const [members, setMembers] = useState<Profile[]>([])
  const [loadingMembers, setLoadingMembers] = useState(true)
  const [query, setQuery] = useState('')
  const [ringStatus, setRingStatus] = useState<Record<string, RingStatus>>({})
  const { onlineProfileIds, seedOnlineProfiles } = useAppStore()

  const connectedIds = useMemo(
    () => new Set(participants.map((p) => p.identity)),
    [participants],
  );

  useEffect(() => {
    if (!channelId) {
      setLoadingMembers(false);
      return;
    }

    const client = getSupabaseClient();
    if (!client) {
      setLoadingMembers(false);
      return;
    }

    let cancelled = false;

    async function loadMembers() {
      const { data } = await client!
        .from("channel_members")
        .select("profile_id, profile:profiles(*)")
        .eq("channel_id", channelId);

      if (cancelled) return;

      const profiles = (data || [])
        .map((row) => row.profile as unknown as Profile)
        .filter((profile): profile is Profile => !!profile);

      setMembers(profiles)
      seedOnlineProfiles(profiles)
      setLoadingMembers(false)
    }

    void loadMembers();

    return () => {
      cancelled = true;
    };
  }, [channelId]);

  const connectedMembers = members.filter((m) => connectedIds.has(m.id));
  const invitables = members
    .filter((m) => !connectedIds.has(m.id))
    .filter((m) =>
      m.display_name?.toLowerCase().includes(query.trim().toLowerCase()),
    );

  async function handleRing(profile: Profile) {
    if (ringStatus[profile.id] === "ringing") return;

    setRingStatus((prev) => ({ ...prev, [profile.id]: "ringing" }));

    const { channels, activeCall } = useAppStore.getState();
    const channel = channels.find((c) => c.id === activeCall?.channel_id);

    const ok = await ringProfile(profile.id, {
      callId,
      channelId,
      isVideo: isVideoCall,
      callerName,
      channelLabel: channel?.name || "a call",
    });

    setRingStatus((prev) => ({
      ...prev,
      [profile.id]: ok ? "sent" : "failed",
    }));
  }

  return (
    <div
      className="w-[320px] shrink-0 flex flex-col h-full"
      style={{
        background: "#1C1F26",
        borderLeft: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      {/* Drawer header */}
      <div
        className="shrink-0 flex items-center justify-between px-4 h-12"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}
      >
        <span
          className="text-[13px] font-semibold"
          style={{ color: "#ffffff" }}
        >
          People
        </span>
        <button
          type="button"
          onClick={onClose}
          className="h-7 w-7 rounded-lg flex items-center justify-center hover:bg-white/10 transition-colors"
          title="Close"
        >
          <X className="h-4 w-4" style={{ color: "rgba(255,255,255,0.6)" }} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {/* In call */}
        <div className="px-2 py-2">
          <div
            className="px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider"
            style={{ color: "rgba(255,255,255,0.45)" }}
          >
            In this call — {participants.length}
          </div>

          {participants.map((p) => (
            <div
              key={p.identity}
              className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg"
            >
              <div
                className="h-8 w-8 rounded-md flex items-center justify-center text-[11px] font-bold text-white shrink-0"
                style={{ background: colorForIdentity(p.identity) }}
              >
                {initialsFor(p.name)}
              </div>

              <div className="min-w-0 flex-1">
                <div
                  className="text-[13px] font-medium truncate"
                  style={{ color: "#ffffff" }}
                >
                  {p.name}
                  {p.isLocal ? " (You)" : ""}
                </div>
              </div>

              {p.muted ? (
                <MicOff
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: "#E01E5A" }}
                />
              ) : (
                <Mic
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: "rgba(255,255,255,0.4)" }}
                />
              )}
            </div>
          ))}
        </div>

        {/* Invite */}
        <div
          className="px-2 py-2"
          style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}
        >
          <div
            className="px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider"
            style={{ color: "rgba(255,255,255,0.45)" }}
          >
            Add members
          </div>

          <div className="px-2 pb-2">
            <div
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg"
              style={{ background: "rgba(255,255,255,0.06)" }}
            >
              <Search
                className="h-3.5 w-3.5 shrink-0"
                style={{ color: "rgba(255,255,255,0.4)" }}
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search members…"
                className="flex-1 bg-transparent outline-none text-[13px] min-w-0"
                style={{ color: "#ffffff" }}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  title="Clear"
                >
                  <X
                    className="h-3.5 w-3.5"
                    style={{ color: "rgba(255,255,255,0.4)" }}
                  />
                </button>
              )}
            </div>
          </div>

          {loadingMembers ? (
            <div className="flex items-center justify-center py-6">
              <Loader2
                className="h-4 w-4 animate-spin"
                style={{ color: "rgba(255,255,255,0.5)" }}
              />
            </div>
          ) : invitables.length === 0 ? (
            <div
              className="px-3 py-3 text-[12px]"
              style={{ color: "rgba(255,255,255,0.45)" }}
            >
              {members.length === 0
                ? "No channel members found."
                : connectedMembers.length === members.length
                  ? "Everyone in this channel is already here."
                  : "No matching members."}
            </div>
          ) : (
            <div className="space-y-0.5">
              {invitables.map((profile) => {
                const status = ringStatus[profile.id] || "idle";

                return (
                  <div
                    key={profile.id}
                    className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors"
                  >
                    {profile.avatar_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={profile.avatar_url}
                        alt=""
                        className="h-8 w-8 rounded-md object-cover shrink-0"
                      />
                    ) : (
                      <div
                        className="h-8 w-8 rounded-md flex items-center justify-center text-[11px] font-bold text-white shrink-0"
                        style={{ background: colorForIdentity(profile.id) }}
                      >
                        {initialsFor(profile.display_name || "?")}
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <div
                        className="text-[13px] font-medium truncate"
                        style={{ color: "#ffffff" }}
                      >
                        {profile.display_name}
                      </div>
                      {(profile.is_online || onlineProfileIds.has(profile.id)) && (
                        <div className="flex items-center gap-1">
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ background: "#2BAC76" }}
                          />
                          <span
                            className="text-[10px]"
                            style={{ color: "rgba(255,255,255,0.45)" }}
                          >
                            Online
                          </span>
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleRing(profile)}
                      disabled={status === "ringing" || status === "sent"}
                      className="h-7 px-2.5 rounded-lg text-[11px] font-semibold flex items-center gap-1 transition-colors disabled:opacity-70"
                      style={{
                        background:
                          status === "sent"
                            ? "rgba(43,172,118,0.15)"
                            : status === "failed"
                              ? "rgba(224,30,90,0.12)"
                              : "rgba(124,92,252,0.18)",
                        color:
                          status === "sent"
                            ? "#5FD3A2"
                            : status === "failed"
                              ? "#FF7A9C"
                              : "#B49BFF",
                      }}
                      title={
                        status === "sent"
                          ? "Ring sent"
                          : status === "failed"
                            ? "Could not deliver ring — the member may be offline"
                            : `Ring ${profile.display_name} to join this call`
                      }
                    >
                      {status === "ringing" ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : status === "sent" ? (
                        <Check className="h-3 w-3" />
                      ) : null}
                      {status === "sent"
                        ? "Rung"
                        : status === "failed"
                          ? "Offline"
                          : "Ring"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div
            className="px-3 pt-2 pb-3 text-[11px] leading-relaxed"
            style={{ color: "rgba(255,255,255,0.35)" }}
          >
            Rung members see an incoming-call banner and can join in one click.
          </div>
        </div>
      </div>
    </div>
  );
}
