// Parley Microphone — a macOS virtual audio device (AudioServerPlugIn / HAL).
//
// It is a *loopback* device: audio an app plays INTO it (output side) becomes
// available on its INPUT side, so other apps (Google Meet, Zoom, …) can select
// "Parley Microphone" as their microphone. Parley's live-translation pipeline
// plays the translated speech into this device; the meeting app hears it as the
// user's mic.
//
// Built on libASPL (MIT), which supplies all the AudioServerPlugIn property
// boilerplate. We only implement the two realtime I/O callbacks and wire up one
// output + one input stream that share a single ring buffer.
//
// The device runs a continuous frame timeline; HAL hands both callbacks a frame
// `timestamp`, with input reads lagging output writes by a small safety offset.
// So writing sample T on the output side and reading sample T on the input side
// is a straight loopback. We zero each frame as it is read so that when no app
// is writing (Parley idle) the input goes silent instead of looping stale audio.

#include <aspl/Driver.hpp>

#include <CoreAudio/AudioServerPlugIn.h>

#include <atomic>
#include <cstring>
#include <vector>

namespace {

// Device format. 48 kHz stereo s16 is the conferencing-friendly default; apps
// that want another rate resample transparently.
constexpr UInt32 SampleRate = 48000;
constexpr UInt32 ChannelCount = 2;

// Ring buffer length in frames (one second). A power-of-two would let us mask
// instead of modulo, but the modulo cost is negligible next to the memcpy and
// this keeps the size legible.
constexpr UInt32 RingFrames = SampleRate;

// Loopback I/O handler: one shared ring buffer between the output and input
// streams. All methods run on the realtime thread — no allocation, no locks.
class LoopbackHandler : public aspl::IORequestHandler
{
public:
    LoopbackHandler()
        : ring_(size_t(RingFrames) * ChannelCount, 0)
    {
    }

    // Output side: an app played `bytesCount` bytes of s16 into the device.
    // Store them in the ring at the write timeline position.
    void OnWriteMixedOutput(const std::shared_ptr<aspl::Stream>&,
        Float64 /*zeroTimestamp*/,
        Float64 timestamp,
        const void* bytes,
        UInt32 bytesCount) override
    {
        const SInt16* in = reinterpret_cast<const SInt16*>(bytes);
        const UInt32 frames = bytesCount / (ChannelCount * sizeof(SInt16));
        const UInt64 base = static_cast<UInt64>(timestamp);
        for (UInt32 f = 0; f < frames; f++) {
            const size_t pos = static_cast<size_t>((base + f) % RingFrames) * ChannelCount;
            for (UInt32 c = 0; c < ChannelCount; c++) {
                ring_[pos + c] = in[f * ChannelCount + c];
            }
        }
    }

    // Input side: fill the client buffer from the ring at the read timeline
    // position, zeroing each frame as it is consumed so idle input is silent.
    void OnReadClientInput(const std::shared_ptr<aspl::Client>&,
        const std::shared_ptr<aspl::Stream>&,
        Float64 /*zeroTimestamp*/,
        Float64 timestamp,
        void* bytes,
        UInt32 bytesCount) override
    {
        SInt16* out = reinterpret_cast<SInt16*>(bytes);
        const UInt32 frames = bytesCount / (ChannelCount * sizeof(SInt16));
        const UInt64 base = static_cast<UInt64>(timestamp);
        for (UInt32 f = 0; f < frames; f++) {
            const size_t pos = static_cast<size_t>((base + f) % RingFrames) * ChannelCount;
            for (UInt32 c = 0; c < ChannelCount; c++) {
                out[f * ChannelCount + c] = ring_[pos + c];
                ring_[pos + c] = 0;
            }
        }
    }

private:
    std::vector<SInt16> ring_;
};

std::shared_ptr<aspl::Driver> CreateParleyDriver()
{
    auto context = std::make_shared<aspl::Context>();

    aspl::DeviceParameters params;
    params.Name = "Parley Microphone";
    params.Manufacturer = "Pathors";
    // Stable UID so apps remember it as the selected device across restarts.
    params.DeviceUID = "com.pathors.parley.virtualmic:0";
    params.ModelUID = "com.pathors.parley.virtualmic";
    params.SampleRate = SampleRate;
    params.ChannelCount = ChannelCount;
    // Mixed-output path → OnWriteMixedOutput receives the combined stream.
    params.EnableMixing = true;

    auto device = std::make_shared<aspl::Device>(context, params);

    // Both directions: apps write to Output, read from Input. Controls give each
    // stream a volume + mute so the device behaves like a normal one in the UI.
    device->AddStreamWithControlsAsync(aspl::Direction::Output);
    device->AddStreamWithControlsAsync(aspl::Direction::Input);

    auto handler = std::make_shared<LoopbackHandler>();
    device->SetIOHandler(handler);

    auto plugin = std::make_shared<aspl::Plugin>(context);
    plugin->AddDevice(device);

    return std::make_shared<aspl::Driver>(context, plugin);
}

} // namespace

// AudioServerPlugIn entry point (referenced by Info.plist's CFPlugInFactories).
extern "C" void* ParleyVirtualMicEntryPoint(CFAllocatorRef /*allocator*/, CFUUIDRef typeUUID)
{
    if (!CFEqual(typeUUID, kAudioServerPlugInTypeUUID)) {
        return nullptr;
    }
    // Keep the driver alive for the lifetime of the host (coreaudiod).
    static std::shared_ptr<aspl::Driver> driver = CreateParleyDriver();
    return driver->GetReference();
}
