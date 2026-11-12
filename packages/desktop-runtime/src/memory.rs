use std::io;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SystemMemoryInfo {
    pub total_bytes: u64,
    pub available_bytes: u64,
}

pub fn get_system_memory_info() -> io::Result<SystemMemoryInfo> {
    #[cfg(target_os = "linux")]
    {
        parse_memory_info(&std::fs::read_to_string("/proc/meminfo")?)
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "system memory telemetry requires Linux",
        ))
    }
}

fn parse_memory_info(input: &str) -> io::Result<SystemMemoryInfo> {
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid system memory telemetry",
        )
    };
    let read = |key: &str| {
        let mut lines = input.lines().filter_map(|line| line.strip_prefix(key));
        let mut fields = lines.next().ok_or_else(invalid)?.split_whitespace();
        let value = fields
            .next()
            .ok_or_else(invalid)?
            .parse::<u64>()
            .map_err(|_| invalid())?;
        if fields.next() != Some("kB") || fields.next().is_some() || lines.next().is_some() {
            return Err(invalid());
        }
        value.checked_mul(1024).ok_or_else(invalid)
    };
    let total_bytes = read("MemTotal:")?;
    let available_bytes = read("MemAvailable:")?;
    if total_bytes == 0 || available_bytes > total_bytes {
        return Err(invalid());
    }
    Ok(SystemMemoryInfo {
        total_bytes,
        available_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_available_memory_instead_of_free_pages() {
        assert_eq!(
            parse_memory_info("MemTotal: 8192 kB\nMemFree: 4 kB\nMemAvailable: 2048 kB\n").unwrap(),
            SystemMemoryInfo {
                total_bytes: 8_388_608,
                available_bytes: 2_097_152,
            }
        );
    }

    #[test]
    fn rejects_missing_invalid_and_overflowing_telemetry() {
        for input in [
            "MemTotal: 8192 kB\n",
            "MemTotal: 0 kB\nMemAvailable: 0 kB\n",
            "MemTotal: 8 kB\nMemAvailable: 9 kB\n",
            "MemTotal: -8 kB\nMemAvailable: 1 kB\n",
            "MemTotal: 8 MB\nMemAvailable: 1 kB\n",
            "MemTotal: 8 kB\nMemTotal: 8 kB\nMemAvailable: 1 kB\n",
            "MemTotal: 18446744073709551615 kB\nMemAvailable: 1 kB\n",
        ] {
            assert!(parse_memory_info(input).is_err(), "{input}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_live_linux_memory() {
        let memory = get_system_memory_info().unwrap();
        assert!(memory.total_bytes > 0);
        assert!(memory.available_bytes <= memory.total_bytes);
    }
}
