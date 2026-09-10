pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/machinewright.worker.v1.rs"));
}

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

pub fn encode_frame(message: &v1::WorkerRequest) -> Vec<u8> {
    use prost::Message;
    let payload = message.encode_to_vec();
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(&payload);
    frame
}

pub fn decode_event(frame: &[u8]) -> Result<v1::WorkerEvent, prost::DecodeError> {
    use prost::Message;
    v1::WorkerEvent::decode(frame)
}

pub fn write_request(
    writer: &mut impl std::io::Write,
    message: &v1::WorkerRequest,
) -> std::io::Result<()> {
    writer.write_all(&encode_frame(message))?;
    writer.flush()
}

pub fn read_event(reader: &mut impl std::io::Read) -> Result<v1::WorkerEvent, FrameError> {
    use prost::Message;

    let mut header = [0_u8; 4];
    reader.read_exact(&mut header)?;
    let size = u32::from_le_bytes(header) as usize;
    if size > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(size));
    }
    let mut payload = vec![0; size];
    reader.read_exact(&mut payload)?;
    Ok(v1::WorkerEvent::decode(payload.as_slice())?)
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("worker protocol I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("worker protocol frame is too large: {0} bytes")]
    TooLarge(usize),
    #[error("worker protocol message is invalid: {0}")]
    Decode(#[from] prost::DecodeError),
}

#[cfg(test)]
mod tests {
    use super::v1::{Hello, WorkerRequest, worker_request};
    use prost::Message;

    fn decode_hex(value: &str) -> Vec<u8> {
        value
            .trim()
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let text = std::str::from_utf8(pair).expect("fixture is UTF-8");
                u8::from_str_radix(text, 16).expect("fixture contains hexadecimal bytes")
            })
            .collect()
    }

    #[test]
    fn python_hello_fixture_round_trips() {
        let fixture = decode_hex(include_str!("../../../../proto/fixtures/hello-request.hex"));
        let request = WorkerRequest::decode(fixture.as_slice()).expect("fixture decodes");
        assert_eq!(
            request.request,
            Some(worker_request::Request::Hello(Hello {
                protocol_version: 1,
                capabilities: vec!["evaluation.v1".into(), "progress.v1".into()],
            }))
        );
        assert_eq!(request.encode_to_vec(), fixture);
    }
}
