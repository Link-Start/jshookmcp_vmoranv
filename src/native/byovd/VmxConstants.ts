/**
 * Intel VMX (Virtual Machine Extensions) constants for EPT hypervisor
 * development.
 *
 * All values sourced from Intel SDM Volume 3C, Chapter 24-28 (VMX) and
 * Chapter 29 (EPT). These are reference constants — not functional code.
 * They will be used by the future EPT hypervisor implementation to
 * configure VMCS fields, interpret VM-exit reasons, and construct EPT
 * page tables.
 *
 * @module byovd/VmxConstants
 */

// ── IA32_VMX MSR Indices (Intel SDM Vol 3C, Appendix A) ──

/** Reports VMX capabilities: VMCS revision ID, VMXON/VMCS region size, memory type, etc. */
export const IA32_VMX_BASIC = 0x480;

/** Allowed 1-settings for pin-based VM-execution controls. */
export const IA32_VMX_PINBASED_CTLS = 0x481;

/** Allowed 1-settings for primary processor-based VM-execution controls. */
export const IA32_VMX_PROCBASED_CTLS = 0x482;

/** Allowed 1-settings for primary processor-based VM-execution controls (true). */
export const IA32_VMX_TRUE_PROCBASED_CTLS = 0x48e;

/** Allowed 1-settings for VM-exit controls. */
export const IA32_VMX_EXIT_CTLS = 0x483;

/** Allowed 1-settings for VM-exit controls (true). */
export const IA32_VMX_TRUE_EXIT_CTLS = 0x48f;

/** Allowed 1-settings for VM-entry controls. */
export const IA32_VMX_ENTRY_CTLS = 0x484;

/** Allowed 1-settings for VM-entry controls (true). */
export const IA32_VMX_TRUE_ENTRY_CTLS = 0x490;

/** Miscellaneous VMX capabilities: CR3-target count, activity states, etc. */
export const IA32_VMX_MISC = 0x485;

/** Allowed 0-settings for CR0 fixed bits in VMX operation. */
export const IA32_VMX_CR0_FIXED0 = 0x486;

/** Allowed 1-settings for CR0 fixed bits in VMX operation. */
export const IA32_VMX_CR0_FIXED1 = 0x487;

/** Allowed 0-settings for CR4 fixed bits in VMX operation. */
export const IA32_VMX_CR4_FIXED0 = 0x488;

/** Allowed 1-settings for CR4 fixed bits in VMX operation. */
export const IA32_VMX_CR4_FIXED1 = 0x489;

/** VMCS enumeration: highest VMCS field index supported. */
export const IA32_VMX_VMCS_ENUM = 0x48a;

/** Allowed 1-settings for secondary processor-based VM-execution controls. */
export const IA32_VMX_PROCBASED_CTLS2 = 0x48b;

/** Allowed 1-settings for secondary processor-based VM-execution controls (true). */
export const IA32_VMX_TRUE_PROCBASED_CTLS2 = 0x491;

/** EPT and VPID capabilities (MSR index). */
export const IA32_VMX_EPT_VPID_CAP = 0x48c;

/** Allowed 1-settings for VM-function controls (if VM-functions are supported). */
export const IA32_VMX_VMFUNC = 0x491;

// ── VMX Basic MSR Bit Layout (IA32_VMX_BASIC) ──

/** Bits 30:0 — VMCS revision identifier used in VMXON region. */
export const VMX_BASIC_VMCS_REVISION_ID_MASK = 0x7fffffff;

/** Bit 31 — reserved, always 0. */
export const VMX_BASIC_RESERVED_BIT31 = 0x80000000;

/** Bits 44:32 — VMCS region size in bytes (shifted value). */
export const VMX_BASIC_VMCS_SIZE_SHIFT = 32;
export const VMX_BASIC_VMCS_SIZE_MASK = 0x1fff;

/** Bit 48 — memory type for VMCS: 0 = WB, 1 = UC (if bit 53=1, this field is reserved). */
export const VMX_BASIC_MEMORY_TYPE_BIT = 48;

/** Bit 49 — INS/OUTS VM-exit info: 0 = INS/OUTS not reported, 1 = reported in VM-exit instruction info. */
export const VMX_BASIC_INS_OUTS_BIT = 49;

/** Bit 53 — 1 = true control MSRs (0x48e/0x48f/0x490/0x491) are supported. */
export const VMX_BASIC_TRUE_CTLS_BIT = 53;

/** Bit 54 — 1 = VMCS shadowing supported in addition to ordinary VMCS. */
export const VMX_BASIC_VMCS_SHADOWING_BIT = 54;

/** Bits 55:55 — Whether any VM-exit can set #VE (virtualization exception). */
export const VMX_BASIC_VM_EXIT_VE_BIT = 55;

// ── VMCS Field Encodings (Intel SDM Vol 3C, Appendix B) ──

/**
 * VMCS field encoding format (32-bit):
 *   Bit 0-9:  Field-specific (index within group)
 *   Bit 10:   0 = VMCS-includes-wide-field (access width = 64-bit when set)
 *   Bit 11-12: Type: 0 = control, 1 = VM-exit info (read-only), 2 = guest state, 3 = host state
 *   Bit 13:   0 = full (natural width), 1 = high (upper 32 bits of 64-bit field)
 *   Bit 14-31: Reserved (must be 0)
 *
 * VMREAD/VMWRITE destination operand determines whether it's 16/32/64/128-bit.
 */

/** Encoding access width bit — when set, field is 64-bit (natural width). */
export const VMCS_ENCODING_WIDE_BIT = 1 << 10;

/** Encoding type mask: bits 11-12. */
export const VMCS_ENCODING_TYPE_SHIFT = 11;
export const VMCS_ENCODING_TYPE_MASK = 0x3;

/** Encoding high bit: when set, reads/writes upper 32 bits of 64-bit field. */
export const VMCS_ENCODING_HIGH_BIT = 1 << 13;

// ── 16-bit Control Fields ──

export const VIRTUAL_PROCESSOR_ID = 0x0000;
export const POSTED_INTERRUPT_NOTIFICATION_VECTOR = 0x0002;
export const EPTP_INDEX = 0x0004;

// ── 16-bit Guest-State Fields ──

export const GUEST_ES_SELECTOR = 0x0800;
export const GUEST_CS_SELECTOR = 0x0802;
export const GUEST_SS_SELECTOR = 0x0804;
export const GUEST_DS_SELECTOR = 0x0806;
export const GUEST_FS_SELECTOR = 0x0808;
export const GUEST_GS_SELECTOR = 0x080a;
export const GUEST_LDTR_SELECTOR = 0x080c;
export const GUEST_TR_SELECTOR = 0x080e;
export const GUEST_INTERRUPT_STATUS = 0x0810;
export const GUEST_PML_INDEX = 0x0812;

// ── 16-bit Host-State Fields ──

export const HOST_ES_SELECTOR = 0x0c00;
export const HOST_CS_SELECTOR = 0x0c02;
export const HOST_SS_SELECTOR = 0x0c04;
export const HOST_DS_SELECTOR = 0x0c06;
export const HOST_FS_SELECTOR = 0x0c08;
export const HOST_GS_SELECTOR = 0x0c0a;
export const HOST_TR_SELECTOR = 0x0c0c;

// ── 64-bit Control Fields ──

export const IO_BITMAP_A_ADDRESS = 0x2000;
export const IO_BITMAP_A_ADDRESS_HIGH = 0x2001;
export const IO_BITMAP_B_ADDRESS = 0x2002;
export const IO_BITMAP_B_ADDRESS_HIGH = 0x2003;
export const MSR_BITMAP_ADDRESS = 0x2004;
export const MSR_BITMAP_ADDRESS_HIGH = 0x2005;
export const VMEXIT_MSR_STORE_ADDRESS = 0x2006;
export const VMEXIT_MSR_STORE_ADDRESS_HIGH = 0x2007;
export const VMEXIT_MSR_LOAD_ADDRESS = 0x2008;
export const VMEXIT_MSR_LOAD_ADDRESS_HIGH = 0x2009;
export const VMENTRY_MSR_LOAD_ADDRESS = 0x200a;
export const VMENTRY_MSR_LOAD_ADDRESS_HIGH = 0x200b;
export const EXECUTIVE_VMCS_POINTER = 0x200c;
export const EXECUTIVE_VMCS_POINTER_HIGH = 0x200d;
export const PML_ADDRESS = 0x200e;
export const PML_ADDRESS_HIGH = 0x200f;
export const TSC_OFFSET = 0x2010;
export const TSC_OFFSET_HIGH = 0x2011;
export const VIRTUAL_APIC_PAGE_ADDRESS = 0x2012;
export const VIRTUAL_APIC_PAGE_ADDRESS_HIGH = 0x2013;
export const APIC_ACCESS_ADDRESS = 0x2014;
export const APIC_ACCESS_ADDRESS_HIGH = 0x2015;
export const POSTED_INTERRUPT_DESC_ADDRESS = 0x2016;
export const POSTED_INTERRUPT_DESC_ADDRESS_HIGH = 0x2017;
export const VM_FUNCTION_CONTROLS = 0x2018;
export const VM_FUNCTION_CONTROLS_HIGH = 0x2019;
export const EPT_POINTER = 0x201a;
export const EPT_POINTER_HIGH = 0x201b;
export const EOI_EXIT_BITMAP_ADDRESS = 0x201c;
export const EOI_EXIT_BITMAP_ADDRESS_HIGH = 0x201d;
export const EPTP_LIST_ADDRESS = 0x2024;
export const EPTP_LIST_ADDRESS_HIGH = 0x2025;
export const VMREAD_BITMAP_ADDRESS = 0x2026;
export const VMREAD_BITMAP_ADDRESS_HIGH = 0x2027;
export const VMWRITE_BITMAP_ADDRESS = 0x2028;
export const VMWRITE_BITMAP_ADDRESS_HIGH = 0x2029;
export const VIRTUALIZATION_EXCEPTION_INFO_ADDRESS = 0x202a;
export const VIRTUALIZATION_EXCEPTION_INFO_ADDRESS_HIGH = 0x202b;
export const XSS_EXITING_BITMAP = 0x202c;
export const XSS_EXITING_BITMAP_HIGH = 0x202d;
export const ENCLS_EXITING_BITMAP_ADDRESS = 0x202e;
export const ENCLS_EXITING_BITMAP_ADDRESS_HIGH = 0x202f;
export const SUB_PAGE_PERMISSION_TABLE_POINTER = 0x2030;
export const SUB_PAGE_PERMISSION_TABLE_POINTER_HIGH = 0x2031;
export const TSC_MULTIPLIER = 0x2032;
export const TSC_MULTIPLIER_HIGH = 0x2033;

// ── 64-bit Read-Only Data Fields (VM-Exit Information) ──

/** Guest-physical address that caused an EPT violation/misconfig. */
export const GUEST_PHYSICAL_ADDRESS = 0x2400;
export const GUEST_PHYSICAL_ADDRESS_HIGH = 0x2401;

// ── 64-bit Guest-State Fields ──

export const VMCS_LINK_POINTER = 0x2800;
export const VMCS_LINK_POINTER_HIGH = 0x2801;
export const GUEST_IA32_DEBUGCTL = 0x2802;
export const GUEST_IA32_DEBUGCTL_HIGH = 0x2803;
export const GUEST_IA32_PAT = 0x2804;
export const GUEST_IA32_PAT_HIGH = 0x2805;
export const GUEST_IA32_EFER = 0x2806;
export const GUEST_IA32_EFER_HIGH = 0x2807;
export const GUEST_IA32_PERF_GLOBAL_CTRL = 0x2808;
export const GUEST_IA32_PERF_GLOBAL_CTRL_HIGH = 0x2809;
export const GUEST_PDPTE0 = 0x280a;
export const GUEST_PDPTE0_HIGH = 0x280b;
export const GUEST_PDPTE1 = 0x280c;
export const GUEST_PDPTE1_HIGH = 0x280d;
export const GUEST_PDPTE2 = 0x280e;
export const GUEST_PDPTE2_HIGH = 0x280f;
export const GUEST_PDPTE3 = 0x2810;
export const GUEST_PDPTE3_HIGH = 0x2811;
export const GUEST_IA32_BNDCFGS = 0x2812;
export const GUEST_IA32_BNDCFGS_HIGH = 0x2813;
export const GUEST_IA32_RTIT_CTL = 0x2814;
export const GUEST_IA32_RTIT_CTL_HIGH = 0x2815;

// ── 64-bit Host-State Fields ──

export const HOST_IA32_PAT = 0x2c00;
export const HOST_IA32_PAT_HIGH = 0x2c01;
export const HOST_IA32_EFER = 0x2c02;
export const HOST_IA32_EFER_HIGH = 0x2c03;
export const HOST_IA32_PERF_GLOBAL_CTRL = 0x2c04;
export const HOST_IA32_PERF_GLOBAL_CTRL_HIGH = 0x2c05;

// ── 32-bit Control Fields ──

export const PIN_BASED_VM_EXECUTION_CONTROLS = 0x4000;
export const PROCESSOR_BASED_VM_EXECUTION_CONTROLS = 0x4002;
export const EXCEPTION_BITMAP = 0x4004;
export const PAGE_FAULT_ERROR_CODE_MASK = 0x4006;
export const PAGE_FAULT_ERROR_CODE_MATCH = 0x4008;
export const CR3_TARGET_COUNT = 0x400a;
export const VM_EXIT_CONTROLS = 0x400c;
export const VM_EXIT_MSR_STORE_COUNT = 0x400e;
export const VM_EXIT_MSR_LOAD_COUNT = 0x4010;
export const VM_ENTRY_CONTROLS = 0x4012;
export const VM_ENTRY_MSR_LOAD_COUNT = 0x4014;
export const VM_ENTRY_INTERRUPTION_INFORMATION = 0x4016;
export const VM_ENTRY_EXCEPTION_ERROR_CODE = 0x4018;
export const VM_ENTRY_INSTRUCTION_LENGTH = 0x401a;
export const TPR_THRESHOLD = 0x401c;
export const SECONDARY_PROCESSOR_BASED_VM_EXECUTION_CONTROLS = 0x401e;
export const PLE_GAP = 0x4020;
export const PLE_WINDOW = 0x4022;

// ── 32-bit Read-Only Data Fields (VM-Exit Information) ──

export const VM_INSTRUCTION_ERROR = 0x4400;
export const EXIT_REASON = 0x4402;
export const VM_EXIT_INTERRUPTION_INFORMATION = 0x4404;
export const VM_EXIT_INTERRUPTION_ERROR_CODE = 0x4406;
export const IDT_VECTORING_INFORMATION = 0x4408;
export const IDT_VECTORING_ERROR_CODE = 0x440a;
export const VM_EXIT_INSTRUCTION_LENGTH = 0x440c;
export const VM_EXIT_INSTRUCTION_INFORMATION = 0x440e;

// ── 32-bit Guest-State Fields ──

export const GUEST_ES_LIMIT = 0x4800;
export const GUEST_CS_LIMIT = 0x4802;
export const GUEST_SS_LIMIT = 0x4804;
export const GUEST_DS_LIMIT = 0x4806;
export const GUEST_FS_LIMIT = 0x4808;
export const GUEST_GS_LIMIT = 0x480a;
export const GUEST_LDTR_LIMIT = 0x480c;
export const GUEST_TR_LIMIT = 0x480e;
export const GUEST_GDTR_LIMIT = 0x4810;
export const GUEST_IDTR_LIMIT = 0x4812;
export const GUEST_ES_ACCESS_RIGHTS = 0x4814;
export const GUEST_CS_ACCESS_RIGHTS = 0x4816;
export const GUEST_SS_ACCESS_RIGHTS = 0x4818;
export const GUEST_DS_ACCESS_RIGHTS = 0x481a;
export const GUEST_FS_ACCESS_RIGHTS = 0x481c;
export const GUEST_GS_ACCESS_RIGHTS = 0x481e;
export const GUEST_LDTR_ACCESS_RIGHTS = 0x4820;
export const GUEST_TR_ACCESS_RIGHTS = 0x4822;
export const GUEST_INTERRUPTIBILITY_STATE = 0x4824;
export const GUEST_ACTIVITY_STATE = 0x4826;
export const GUEST_SMBASE = 0x4828;
export const GUEST_IA32_SYSENTER_CS = 0x482a;
export const VMX_PREEMPTION_TIMER_VALUE = 0x482e;

// ── 32-bit Host-State Fields ──

export const HOST_IA32_SYSENTER_CS = 0x4c00;

// ── Natural-Width Control Fields ──

export const CR0_GUEST_HOST_MASK = 0x6000;
export const CR4_GUEST_HOST_MASK = 0x6002;
export const CR0_READ_SHADOW = 0x6004;
export const CR4_READ_SHADOW = 0x6006;
export const CR3_TARGET_VALUE0 = 0x6008;
export const CR3_TARGET_VALUE1 = 0x600a;
export const CR3_TARGET_VALUE2 = 0x600c;
export const CR3_TARGET_VALUE3 = 0x600e;

// ── Natural-Width Read-Only Data Fields ──

export const EXIT_QUALIFICATION = 0x6400;
export const IO_RCX = 0x6402;
export const IO_RSI = 0x6404;
export const IO_RDI = 0x6406;
export const IO_RIP = 0x6408;
export const GUEST_LINEAR_ADDRESS = 0x640a;

// ── Natural-Width Guest-State Fields ──

export const GUEST_CR0 = 0x6800;
export const GUEST_CR3 = 0x6802;
export const GUEST_CR4 = 0x6804;
export const GUEST_ES_BASE = 0x6806;
export const GUEST_CS_BASE = 0x6808;
export const GUEST_SS_BASE = 0x680a;
export const GUEST_DS_BASE = 0x680c;
export const GUEST_FS_BASE = 0x680e;
export const GUEST_GS_BASE = 0x6810;
export const GUEST_LDTR_BASE = 0x6812;
export const GUEST_TR_BASE = 0x6814;
export const GUEST_GDTR_BASE = 0x6816;
export const GUEST_IDTR_BASE = 0x6818;
export const GUEST_DR7 = 0x681a;
export const GUEST_RSP = 0x681c;
export const GUEST_RIP = 0x681e;
export const GUEST_RFLAGS = 0x6820;
export const GUEST_PENDING_DEBUG_EXCEPTIONS = 0x6822;
export const GUEST_IA32_SYSENTER_ESP = 0x6824;
export const GUEST_IA32_SYSENTER_EIP = 0x6826;

// ── Natural-Width Host-State Fields ──

export const HOST_CR0 = 0x6c00;
export const HOST_CR3 = 0x6c02;
export const HOST_CR4 = 0x6c04;
export const HOST_FS_BASE = 0x6c06;
export const HOST_GS_BASE = 0x6c08;
export const HOST_TR_BASE = 0x6c0a;
export const HOST_GDTR_BASE = 0x6c0c;
export const HOST_IDTR_BASE = 0x6c0e;
export const HOST_IA32_SYSENTER_ESP = 0x6c10;
export const HOST_IA32_SYSENTER_EIP = 0x6c12;
export const HOST_RSP = 0x6c14;
export const HOST_RIP = 0x6c16;

// ── Pin-Based VM-Execution Controls (bitmap) ──

export const PIN_BASED_EXT_INTERRUPT_EXITING = 1 << 0;
export const PIN_BASED_NMI_EXITING = 1 << 3;
export const PIN_BASED_VIRTUAL_NMI = 1 << 5;
export const PIN_BASED_ACTIVATE_PREEMPTION_TIMER = 1 << 6;
export const PIN_BASED_PROCESS_POSTED_INTERRUPTS = 1 << 7;

// ── Primary Processor-Based VM-Execution Controls (bitmap) ──

export const CPU_BASED_INTERRUPT_WINDOW_EXITING = 1 << 2;
export const CPU_BASED_USE_TSC_OFFSETTING = 1 << 3;
export const CPU_BASED_HLT_EXITING = 1 << 7;
export const CPU_BASED_INVLPG_EXITING = 1 << 9;
export const CPU_BASED_MWAIT_EXITING = 1 << 10;
export const CPU_BASED_RDPMC_EXITING = 1 << 11;
export const CPU_BASED_RDTSC_EXITING = 1 << 12;
export const CPU_BASED_CR3_LOAD_EXITING = 1 << 15;
export const CPU_BASED_CR3_STORE_EXITING = 1 << 16;
export const CPU_BASED_CR8_LOAD_EXITING = 1 << 19;
export const CPU_BASED_CR8_STORE_EXITING = 1 << 20;
export const CPU_BASED_USE_TPR_SHADOW = 1 << 21;
export const CPU_BASED_NMI_WINDOW_EXITING = 1 << 22;
export const CPU_BASED_MOV_DR_EXITING = 1 << 23;
export const CPU_BASED_UNCOND_IO_EXITING = 1 << 24;
export const CPU_BASED_USE_IO_BITMAPS = 1 << 25;
export const CPU_BASED_MONITOR_TRAP_FLAG = 1 << 27;
export const CPU_BASED_USE_MSR_BITMAPS = 1 << 28;
export const CPU_BASED_MONITOR_EXITING = 1 << 29;
export const CPU_BASED_PAUSE_EXITING = 1 << 30;
export const CPU_BASED_ACTIVATE_SECONDARY_CONTROLS = 1 << 31;

// ── Secondary Processor-Based VM-Execution Controls (bitmap) ──

export const CPU_BASED_CTL2_VIRTUALIZE_APIC_ACCESSES = 1 << 0;
export const CPU_BASED_CTL2_ENABLE_EPT = 1 << 1;
export const CPU_BASED_CTL2_DESC_TABLE_EXITING = 1 << 2;
export const CPU_BASED_CTL2_ENABLE_RDTSCP = 1 << 3;
export const CPU_BASED_CTL2_VIRTUALIZE_X2APIC_MODE = 1 << 4;
export const CPU_BASED_CTL2_ENABLE_VPID = 1 << 5;
export const CPU_BASED_CTL2_WBINVD_EXITING = 1 << 6;
export const CPU_BASED_CTL2_UNRESTRICTED_GUEST = 1 << 7;
export const CPU_BASED_CTL2_APIC_REGISTER_VIRTUALIZATION = 1 << 8;
export const CPU_BASED_CTL2_VIRTUAL_INTERRUPT_DELIVERY = 1 << 9;
export const CPU_BASED_CTL2_PAUSE_LOOP_EXITING = 1 << 10;
export const CPU_BASED_CTL2_RDRAND_EXITING = 1 << 11;
export const CPU_BASED_CTL2_ENABLE_INVPCID = 1 << 12;
export const CPU_BASED_CTL2_ENABLE_VM_FUNCTIONS = 1 << 13;
export const CPU_BASED_CTL2_VMCS_SHADOWING = 1 << 14;
export const CPU_BASED_CTL2_ENABLE_ENCLS_EXITING = 1 << 15;
export const CPU_BASED_CTL2_RDSEED_EXITING = 1 << 16;
export const CPU_BASED_CTL2_ENABLE_PML = 1 << 17;
export const CPU_BASED_CTL2_EPT_VIOLATION_VE = 1 << 18;
export const CPU_BASED_CTL2_CONCEAL_VMX_FROM_PT = 1 << 19;
export const CPU_BASED_CTL2_ENABLE_XSAVES_XRSTORS = 1 << 20;
export const CPU_BASED_CTL2_MODE_BASED_EXECUTE_CONTROL_FOR_EPT = 1 << 22;
export const CPU_BASED_CTL2_SUB_PAGE_WRITE_PERMISSIONS_FOR_EPT = 1 << 23;
export const CPU_BASED_CTL2_INTEL_PT_USES_GUEST_ADDRESS = 1 << 24;
export const CPU_BASED_CTL2_USE_TSC_SCALING = 1 << 25;
export const CPU_BASED_CTL2_ENABLE_ENCLV_EXITING = 1 << 28;

// ── VM-Exit Controls (bitmap) ──

export const VM_EXIT_SAVE_DEBUG_CONTROLS = 1 << 2;
export const VM_EXIT_HOST_ADDR_SPACE_SIZE = 1 << 9;
export const VM_EXIT_LOAD_IA32_PERF_GLOBAL_CTRL = 1 << 12;
export const VM_EXIT_ACK_INTERRUPT_ON_EXIT = 1 << 15;
export const VM_EXIT_SAVE_IA32_PAT = 1 << 18;
export const VM_EXIT_LOAD_IA32_PAT = 1 << 19;
export const VM_EXIT_SAVE_IA32_EFER = 1 << 20;
export const VM_EXIT_LOAD_IA32_EFER = 1 << 21;
export const VM_EXIT_SAVE_PREEMPTION_TIMER = 1 << 22;
export const VM_EXIT_CLEAR_IA32_BNDCFGS = 1 << 23;
export const VM_EXIT_CLEAR_IA32_RTIT_CTL = 1 << 25;
export const VM_EXIT_LOAD_IA32_CET = 1 << 26;

// ── VM-Entry Controls (bitmap) ──

export const VM_ENTRY_LOAD_DEBUG_CONTROLS = 1 << 2;
export const VM_ENTRY_IA32E_MODE_GUEST = 1 << 9;
export const VM_ENTRY_ENTRY_TO_SMM = 1 << 10;
export const VM_ENTRY_DEACTIVATE_DUAL_MONITOR = 1 << 11;
export const VM_ENTRY_LOAD_IA32_PERF_GLOBAL_CTRL = 1 << 13;
export const VM_ENTRY_LOAD_IA32_PAT = 1 << 14;
export const VM_ENTRY_LOAD_IA32_EFER = 1 << 15;
export const VM_ENTRY_LOAD_IA32_BNDCFGS = 1 << 16;
export const VM_ENTRY_CONCEAL_VMX_FROM_PT = 1 << 17;
export const VM_ENTRY_LOAD_IA32_RTIT_CTL = 1 << 18;
export const VM_ENTRY_LOAD_IA32_CET = 1 << 19;

// ── VM-Exit Reasons (basic, from EXIT_REASON VMCS field) ──

export const VMEXIT_REASON_EXCEPTION_NMI = 0;
export const VMEXIT_REASON_EXTERNAL_INTERRUPT = 1;
export const VMEXIT_REASON_TRIPLE_FAULT = 2;
export const VMEXIT_REASON_INIT = 3;
export const VMEXIT_REASON_SIPI = 4;
export const VMEXIT_REASON_IO_SMI = 5;
export const VMEXIT_REASON_OTHER_SMI = 6;
export const VMEXIT_REASON_INTERRUPT_WINDOW = 7;
export const VMEXIT_REASON_NMI_WINDOW = 8;
export const VMEXIT_REASON_TASK_SWITCH = 9;
export const VMEXIT_REASON_CPUID = 10;
export const VMEXIT_REASON_GETSEC = 11;
export const VMEXIT_REASON_HLT = 12;
export const VMEXIT_REASON_INVD = 13;
export const VMEXIT_REASON_INVLPG = 14;
export const VMEXIT_REASON_RDPMC = 15;
export const VMEXIT_REASON_RDTSC = 16;
export const VMEXIT_REASON_RSM = 17;
export const VMEXIT_REASON_VMCALL = 18;
export const VMEXIT_REASON_VMCLEAR = 19;
export const VMEXIT_REASON_VMLAUNCH = 20;
export const VMEXIT_REASON_VMPTRLD = 21;
export const VMEXIT_REASON_VMPTRST = 22;
export const VMEXIT_REASON_VMREAD = 23;
export const VMEXIT_REASON_VMRESUME = 24;
export const VMEXIT_REASON_VMWRITE = 25;
export const VMEXIT_REASON_VMXOFF = 26;
export const VMEXIT_REASON_VMXON = 27;
export const VMEXIT_REASON_CR_ACCESS = 28;
export const VMEXIT_REASON_DR_ACCESS = 29;
export const VMEXIT_REASON_IO_INSTRUCTION = 30;
export const VMEXIT_REASON_MSR_READ = 31;
export const VMEXIT_REASON_MSR_WRITE = 32;
export const VMEXIT_REASON_INVALID_GUEST_STATE = 33;
export const VMEXIT_REASON_MSR_LOADING_FAILURE = 34;
export const VMEXIT_REASON_MWAIT_INSTRUCTION = 36;
export const VMEXIT_REASON_MONITOR_TRAP_FLAG = 37;
export const VMEXIT_REASON_MONITOR_INSTRUCTION = 39;
export const VMEXIT_REASON_PAUSE_INSTRUCTION = 40;
export const VMEXIT_REASON_MCE_DURING_VMENTRY = 41;
export const VMEXIT_REASON_TPR_BELOW_THRESHOLD = 43;
export const VMEXIT_REASON_APIC_ACCESS = 44;
export const VMEXIT_REASON_VIRTUALIZED_EOI = 45;
export const VMEXIT_REASON_GDTR_IDTR_ACCESS = 46;
export const VMEXIT_REASON_LDTR_TR_ACCESS = 47;
export const VMEXIT_REASON_EPT_VIOLATION = 48;
export const VMEXIT_REASON_EPT_MISCONFIGURATION = 49;
export const VMEXIT_REASON_INVEPT = 50;
export const VMEXIT_REASON_RDTSCP = 51;
export const VMEXIT_REASON_VMX_PREEMPTION_TIMER = 52;
export const VMEXIT_REASON_INVVPID = 53;
export const VMEXIT_REASON_WBINVD = 54;
export const VMEXIT_REASON_XSETBV = 55;
export const VMEXIT_REASON_APIC_WRITE = 56;
export const VMEXIT_REASON_RDRAND = 57;
export const VMEXIT_REASON_INVPCID = 58;
export const VMEXIT_REASON_VMFUNC = 59;
export const VMEXIT_REASON_ENCLS = 60;
export const VMEXIT_REASON_RDSEED = 61;
export const VMEXIT_REASON_PAGE_MODIFICATION_LOG_FULL = 62;
export const VMEXIT_REASON_XSAVES = 63;
export const VMEXIT_REASON_XRSTORS = 64;
export const VMEXIT_REASON_PT_WRITE = 66;
export const VMEXIT_REASON_ENCLV = 67;
export const VMEXIT_REASON_UMWAIT = 69;
export const VMEXIT_REASON_TPAUSE = 70;
export const VMEXIT_REASON_BUS_LOCK = 73;
export const VMEXIT_REASON_NOTIFY = 74;

/** Bit 31 of EXIT_REASON encodes whether the VM-exit occurred during VM-entry. */
export const VMX_EXIT_REASON_ENTRY_FAILURE_BIT = 1 << 31;

// ── EPT (Extended Page Tables) Structures ──

/**
 * EPT pointer (EPTP) format — loaded into the EPTP VMCS field.
 *
 * Bits 0-2:   Memory type (0 = UC, 6 = WB)
 * Bits 3-5:   Page-walk length - 1 (3 = 4-level walk: PML4 → PDPT → PD → PT)
 * Bit  6:     1 = enable accessed and dirty flags for EPT
 * Bit  7:     Reserved (must be 0)
 * Bits 11-0:  Must be 0 in the EPTP value (reserved/adjust fields)
 * Bits N-1:12: Physical address of the EPT PML4 table (4-KByte aligned)
 */
export const EPT_MEMORY_TYPE_UC = 0;
export const EPT_MEMORY_TYPE_WB = 6;

/**
 * Build an EPTP value.
 * @param pml4PhysAddr Physical address of the PML4 table (must be 4KB aligned).
 * @param memoryType EPT paging-structure memory type (0=UC, 6=WB).
 * @param walkLength Page-walk length (3 for 4-level, 4 for 5-level).
 * @param enableAD Enable accessed/dirty flags.
 */
export function makeEptPointer(
  pml4PhysAddr: bigint,
  memoryType: number = EPT_MEMORY_TYPE_WB,
  walkLength: number = 3,
  enableAD: boolean = false,
): bigint {
  let eptp = pml4PhysAddr & 0xfffffffffffff000n;
  eptp |= BigInt(memoryType & 0x7);
  eptp |= BigInt((walkLength - 1) & 0x7) << 3n;
  if (enableAD) eptp |= 1n << 6n;
  return eptp;
}

/**
 * EPT PML4 Entry (512 entries, each 8 bytes).
 *
 * Bits 0-2:     Read (0) / Write (1) / Execute (2) access rights.
 *               Bit 2 controls execute access: 0 = data access allowed, not execution.
 * Bit  3-5:     Memory type for this entry's sub-table.
 * Bit  6:       1 = ignore PAT memory type for this entry.
 * Bit  7:       Reserved (must be 0).
 * Bit  8:       Accessed flag (set by hardware on first access).
 * Bit  9:       Reserved (ignored in some entries).
 * Bit  10:      Execute access for user-mode linear addresses (0 or 1).
 * Bit  11:      Reserved (must be 0).
 * Bits N-1:12:  Physical address of the next-level table (PDPT).
 * Bit  N:       Suppress #VE (when bit 63: 0 = do not suppress).
 */
export interface EptPml4Entry {
  /** PhysAddr of the PDPT page. */
  pdptPhysAddr: bigint;
  readAccess: boolean;
  writeAccess: boolean;
  executeAccess: boolean;
  userExecuteAccess: boolean;
  /** When true, instruction fetches from this range cause #VE. */
  suppressVE: boolean;
}

/** Serialize an EPT PML4E to its 64-bit hardware representation. */
export function encodeEptPml4e(entry: EptPml4Entry): bigint {
  let val = entry.pdptPhysAddr & 0xfffffffffffff000n;
  if (entry.readAccess) val |= 1n << 0n;
  if (entry.writeAccess) val |= 1n << 1n;
  if (entry.executeAccess) val |= 1n << 2n;
  if (entry.userExecuteAccess) val |= 1n << 10n;
  if (entry.suppressVE) val |= 1n << 63n;
  return val;
}

/**
 * EPT Page-Directory-Pointer-Table Entry (512 entries, each 8 bytes).
 * Same layout as PML4E, but points to a Page Directory.
 */
export interface EptPdptEntry {
  pdPhysAddr: bigint;
  readAccess: boolean;
  writeAccess: boolean;
  executeAccess: boolean;
  /** When true, this is a 1GB large page (bit 7 set). */
  largePage: boolean;
  suppressVE: boolean;
}

export function encodeEptPdpte(entry: EptPdptEntry): bigint {
  let val = entry.pdPhysAddr & 0xfffffffffffff000n;
  if (entry.readAccess) val |= 1n << 0n;
  if (entry.writeAccess) val |= 1n << 1n;
  if (entry.executeAccess) val |= 1n << 2n;
  if (entry.largePage) val |= 1n << 7n;
  if (entry.suppressVE) val |= 1n << 63n;
  return val;
}

/**
 * EPT Page-Directory Entry (512 entries, each 8 bytes).
 * Same layout as PML4E, but points to a Page Table (or is a 2MB large page).
 */
export interface EptPdEntry {
  ptPhysAddr: bigint;
  readAccess: boolean;
  writeAccess: boolean;
  executeAccess: boolean;
  /** When true, this is a 2MB large page (bit 7 set). */
  largePage: boolean;
  suppressVE: boolean;
}

export function encodeEptPde(entry: EptPdEntry): bigint {
  let val = entry.ptPhysAddr & 0xfffffffffffff000n;
  if (entry.readAccess) val |= 1n << 0n;
  if (entry.writeAccess) val |= 1n << 1n;
  if (entry.executeAccess) val |= 1n << 2n;
  if (entry.largePage) val |= 1n << 7n;
  if (entry.suppressVE) val |= 1n << 63n;
  return val;
}

/**
 * EPT Page-Table Entry (512 entries, each 8 bytes).
 * Points to a 4KB physical page.
 */
export interface EptPtEntry {
  physAddr: bigint;
  readAccess: boolean;
  writeAccess: boolean;
  executeAccess: boolean;
  /** Memory type for this 4KB page (0-7). */
  memoryType: number;
  /** When true, ignore PAT and use the memoryType field. */
  ignorePAT: boolean;
  suppressVE: boolean;
}

export function encodeEptPte(entry: EptPtEntry): bigint {
  let val = entry.physAddr & 0xfffffffffffff000n;
  if (entry.readAccess) val |= 1n << 0n;
  if (entry.writeAccess) val |= 1n << 1n;
  if (entry.executeAccess) val |= 1n << 2n;
  val |= BigInt(entry.memoryType & 0x7) << 3n;
  if (entry.ignorePAT) val |= 1n << 6n;
  if (entry.suppressVE) val |= 1n << 63n;
  return val;
}

// ── EPT Violation Qualification (EXIT_QUALIFICATION on EPT violation) ──

/** Bit 0: data read caused the violation. */
export const EPT_VIOLATION_DATA_READ = 1 << 0;
/** Bit 1: data write caused the violation. */
export const EPT_VIOLATION_DATA_WRITE = 1 << 1;
/** Bit 2: instruction fetch caused the violation. */
export const EPT_VIOLATION_INSTRUCTION_FETCH = 1 << 2;
/** Bit 3: EPT entry's read access bit was clear (otherwise entry was not present). */
export const EPT_VIOLATION_READABLE = 1 << 3;
/** Bit 4: EPT entry's write access bit was clear. */
export const EPT_VIOLATION_WRITABLE = 1 << 4;
/** Bit 5: EPT entry's execute access bit was clear. */
export const EPT_VIOLATION_EXECUTABLE = 1 << 5;
/** Bit 6: The violating access was to a guest-physical address that is a phantom address. */
export const EPT_VIOLATION_PHANTOM_ADDRESS = 1 << 6;
/** Bit 7: The linear address is valid (set when the guest-linear address is available). */
export const EPT_VIOLATION_GLA_VALID = 1 << 7;
/** Bit 8: If set, the violation was caused by an EPT paging-structure entry with the NMI-unblocking sub-field. */
export const EPT_VIOLATION_NMI_UNBLOCKING = 1 << 8;
/** Bits 63:12: Reserved. */

// ── EPT Capability Flags (from IA32_VMX_EPT_VPID_CAP MSR) ──

/** Execute-only translations supported. */
export const EPT_CAP_EXECUTE_ONLY = 1 << 0;

/** EPT page-walk length 4 (5-level paging: PML5→PML4→PDPT→PD→PT) supported. */
export const EPT_CAP_PAGE_WALK_LENGTH_4 = 1 << 6;

/** UC memory type for EPT paging structures supported. */
export const EPT_CAP_MEMORY_TYPE_UC = 1 << 8;

/** WB memory type for EPT paging structures supported. */
export const EPT_CAP_MEMORY_TYPE_WB = 1 << 14;

/** 2MB large pages supported. */
export const EPT_CAP_2MB_PAGES = 1 << 16;

/** 1GB large pages supported. */
export const EPT_CAP_1GB_PAGES = 1 << 17;

/** Accessed and dirty flags for EPT supported. */
export const EPT_CAP_ACCESSED_DIRTY = 1 << 21;

/** EPT violation #VE supported. */
export const EPT_CAP_VE = 1 << 25;

/** Mode-based execute control for EPT supported (execute-only for user mode). */
export const EPT_CAP_MODE_BASED_EXECUTE = 1 << 26;

/** Sub-page write permissions supported (SPP). */
export const EPT_CAP_SUB_PAGE_WRITE_PERMISSIONS = 1 << 35;

// ── VPID Capability Flags ──

/** INVVPID instruction with individual-address type supported. */
export const VPID_CAP_INVVPID_INDIVIDUAL_ADDRESS = 1 << 40;

/** INVVPID instruction with single-context type supported. */
export const VPID_CAP_INVVPID_SINGLE_CONTEXT = 1 << 41;

/** INVVPID instruction with all-contexts type supported. */
export const VPID_CAP_INVVPID_ALL_CONTEXTS = 1 << 42;

/** INVVPID instruction with single-context-retaining-globals type supported. */
export const VPID_CAP_INVVPID_SINGLE_CONTEXT_RETAIN_GLOBALS = 1 << 43;

// ── CR Access Exit Qualification Masks ──

export const CR_ACCESS_TYPE_MOV_TO_CR = 0;
export const CR_ACCESS_TYPE_MOV_FROM_CR = 1;
export const CR_ACCESS_TYPE_CLTS = 2;
export const CR_ACCESS_TYPE_LMSW = 3;

export const CR_ACCESS_REG_SHIFT = 8;
export const CR_ACCESS_REG_MASK = 0xf;
export const CR_ACCESS_LMSW_SRC_SHIFT = 16;
export const CR_ACCESS_LMSW_SRC_MASK = 0xf;
export const CR_ACCESS_GP_REG_SHIFT = 8; // CR0/CR4 access: GP register
export const CR_ACCESS_GP_REG_MASK = 0xf;

// ── EPT Table Sizes ──

/** Number of entries per EPT table level. */
export const EPT_TABLE_ENTRIES = 512;

/** Size of each entry in bytes. */
export const EPT_ENTRY_SIZE = 8;

/** Total size of one EPT table page (512 entries * 8 bytes). */
export const EPT_TABLE_SIZE = 4096;
