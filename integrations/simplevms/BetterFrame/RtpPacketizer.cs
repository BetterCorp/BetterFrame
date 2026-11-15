using System.Buffers.Binary;
using System.Security.Cryptography;

namespace BetterCorp.BetterFrame;

/// <summary>RFC 6184 / RFC 7798 video RTP payloads. TCP interleaving is handled by the session.</summary>
public sealed class RtpPacketizer(bool hevc)
{
  private ushort _sequence = (ushort)RandomNumberGenerator.GetInt32(65536);
  private readonly uint _ssrc = BinaryPrimitives.ReadUInt32BigEndian(RandomNumberGenerator.GetBytes(4));
  public IEnumerable<byte[]> Packetize(ReadOnlyMemory<byte> memory, uint timestamp, bool marker)
  {
    var nal = memory.ToArray();
    if (nal.Length == 0) yield break;
    const int maximumPayload = 1200;
    if (nal.Length <= maximumPayload) { yield return Packet(nal, timestamp, marker); yield break; }
    var headerSize = hevc ? 2 : 1;
    if (nal.Length <= headerSize) yield break;
    var prefixLength = hevc ? 3 : 2;
    var position = headerSize;
    while (position < nal.Length) {
      var length = Math.Min(maximumPayload - prefixLength, nal.Length - position);
      var start = position == headerSize; var end = position + length == nal.Length;
      var payload = new byte[length + prefixLength];
      if (hevc) {
        payload[0] = (byte)((nal[0] & 0x81) | (49 << 1)); payload[1] = nal[1];
        payload[2] = (byte)(((nal[0] >> 1) & 0x3f) | (start ? 0x80 : 0) | (end ? 0x40 : 0));
      } else {
        payload[0] = (byte)((nal[0] & 0xe0) | 28);
        payload[1] = (byte)((nal[0] & 0x1f) | (start ? 0x80 : 0) | (end ? 0x40 : 0));
      }
      Array.Copy(nal, position, payload, prefixLength, length);
      yield return Packet(payload, timestamp, marker && end); position += length;
    }
  }
  private byte[] Packet(byte[] payload, uint timestamp, bool marker)
  {
    var packet = new byte[payload.Length + 12]; packet[0] = 0x80; packet[1] = (byte)(96 | (marker ? 0x80 : 0));
    BinaryPrimitives.WriteUInt16BigEndian(packet.AsSpan(2), _sequence++);
    BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(4), timestamp); BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(8), _ssrc);
    payload.CopyTo(packet, 12); return packet;
  }
}
