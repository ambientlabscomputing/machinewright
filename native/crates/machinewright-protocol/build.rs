fn main() {
    let proto = "../../../proto/machinewright_worker.proto";
    println!("cargo:rerun-if-changed={proto}");
    prost_build::compile_protos(&[proto], &["../../../proto"]).expect("compile worker protocol");
}
