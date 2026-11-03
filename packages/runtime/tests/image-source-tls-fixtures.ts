// Public test-only self-signed identity for the local HTTPS proxy fixture.
// This key is deliberately checked in, grants no real access, and is never used
// by product code. Regenerate both together if the fixture expires (2126).
export const imageSourceTestKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgMad6zgNaie4RmUrb
wAF+t9SzlLUPEkAAmIiUb2RR5lihRANCAATo35qhCc4t1sp+aP0JsIfm6fxa00+W
k56L2osHYhGPP0cHUCsACSoOo4AJ/eQxJSmbfM98nSUpIxr2Ry42DA0j
-----END PRIVATE KEY-----
`;
export const imageSourceTestCert = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUQmkDxBpIKOFAM4k0/i4dniiIIMQwCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWaW1hZ2VzLmV4YW1wbGUuaW52YWxpZDAgFw0yNjExMDMwODQz
NDdaGA8yMTI2MTAxMDA4NDM0N1owITEfMB0GA1UEAwwWaW1hZ2VzLmV4YW1wbGUu
aW52YWxpZDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABOjfmqEJzi3Wyn5o/Qmw
h+bp/FrTT5aTnovaiwdiEY8/RwdQKwAJKg6jgAn95DElKZt8z3ydJSkjGvZHLjYM
DSOjVTBTMB0GA1UdDgQWBBSWgV0TbVz9AHJ521X6Gu4V5EUzJjAhBgNVHREEGjAY
ghZpbWFnZXMuZXhhbXBsZS5pbnZhbGlkMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZI
zj0EAwIDSAAwRQIgIs/GGpBl4GJ4dRGpmeutopc7mT0/ueoltFSzgOwCyy8CIQDA
3lsuNOJFDqucYVWI3N1Npde3x8fLk//RZcpIzu/F1w==
-----END CERTIFICATE-----
`;
