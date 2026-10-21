import type { PoolClient } from "pg";

/**
 * D203 (Tyler: "it should be ONLY the contact's timezone"). Where a contact's zone comes from, most trusted first: the zone they
 * picked when booking (Calendly gives the invitee's own), GHL's contact time-zone field, their phone's US/Canada area code; the
 * offer's zone only when none is known (`company_default`), and then every time a text shows carries its zone's name.
 */
export type ZoneSource = "booking" | "ghl" | "phone" | "company_default";
const RANK: Record<ZoneSource, number> = { booking: 3, ghl: 2, phone: 1, company_default: 0 };

/** Writes the zone unless the contact already has one from a more trusted source (a booking replaces a booking: the latest choice). */
export async function setContactZone(c: PoolClient, contactId: string, zone: string, source: ZoneSource): Promise<boolean> {
  const r = await c.query(`update contacts set timezone=$2, timezone_source=$3, updated_at=now() where id=$1
    and (timezone is distinct from $2 or timezone_source is distinct from $3)
    and (case coalesce(timezone_source,'company_default') when 'booking' then 3 when 'ghl' then 2 when 'phone' then 1 else 0 end) <= $4`, [contactId, zone, source, RANK[source]]);
  return (r.rowCount ?? 0) > 0;
}

// The area's main zone; an area code that spans two zones takes the one most of its people are in.
const NY = "America/New_York", CHI = "America/Chicago", DEN = "America/Denver", PHX = "America/Phoenix", LA = "America/Los_Angeles";
const AREAS: [string, string][] = [
  [NY, "201 202 203 207 212 215 216 220 223 227 229 234 239 240 248 252 267 272 276 283 301 302 304 305 313 315 321 324 326 329 330 332 336 339 347 351 352 363 380 386 401 404 407 410 412 413 419 423 434 436 440 443 445 448 470 472 475 478 484 502 508 513 516 517 518 540 551 561 567 570 571 582 585 586 603 606 607 609 610 614 617 624 631 640 645 646 656 667 678 679 680 681 686 689 703 704 706 716 717 718 724 727 728 732 734 740 743 754 757 762 770 771 772 774 781 786 802 803 804 810 813 814 821 826 828 835 838 839 845 848 854 856 857 859 860 862 863 864 865 878 904 908 910 912 914 917 919 929 934 937 941 943 947 948 954 959 973 978 980 984 989"],
  ["America/Indiana/Indianapolis", "260 317 463 574 765 812 930"],
  ["America/Detroit", "231 269 616 906"],
  [CHI, "205 210 214 217 218 219 224 225 228 251 254 256 262 270 274 281 308 309 312 314 316 318 319 320 325 327 331 334 337 346 361 364 402 405 409 414 417 430 432 447 464 469 479 501 504 507 512 515 531 534 539 557 563 572 573 580 601 605 608 612 615 618 620 629 630 636 641 651 659 660 662 682 701 708 712 713 715 726 730 731 737 763 769 773 779 785 806 815 816 817 830 832 847 850 861 870 872 901 903 913 918 920 931 936 938 940 945 952 956 972 975 979 985"],
  [DEN, "303 307 385 406 435 505 575 719 720 801 915 970 983"],
  ["America/Boise", "208 986"],
  [PHX, "480 520 602 623 928"],
  [LA, "206 209 213 253 279 310 323 341 350 360 369 408 415 424 425 442 458 503 509 510 530 541 559 562 564 619 626 628 650 657 661 669 702 707 714 725 747 760 775 805 818 820 831 840 858 909 916 925 949 951 971"],
  ["America/Anchorage", "907"],
  ["Pacific/Honolulu", "808"],
  ["America/Puerto_Rico", "787 939"],
  ["America/Vancouver", "236 250 257 604 672 778"],
  ["America/Edmonton", "368 403 587 780 825"],
  ["America/Regina", "306 474 639"],
  ["America/Winnipeg", "204 431 584"],
  ["America/Toronto", "226 249 263 289 343 354 365 367 382 416 418 437 438 450 468 514 519 548 579 581 613 647 683 705 742 753 807 819 873 905"],
  ["America/Moncton", "428 506"],
  ["America/Halifax", "782 902"],
  ["America/St_Johns", "709 879"],
];
const AREA_ZONE = new Map<string, string>(AREAS.flatMap(([zone, codes]) => codes.split(" ").filter((x) => /^\d{3}$/.test(x)).map((code) => [code, zone] as [string, string])));

/** The zone a US/Canada number's area code is in (+1 and ten digits), else null (toll-free, other countries, an unknown area). */
export function phoneZone(phone: string | null | undefined): string | null {
  const d = String(phone ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d.length === 10 ? d : null;
  return ten ? AREA_ZONE.get(ten.slice(0, 3)) ?? null : null;
}

/** A Luxon format with no zone in it gets the zone's name, for a time shown in a zone that is not known to be the contact's. */
export const withZoneName = (format: string) => (/[zZ]/.test(format.replace(/'[^']*'/g, "")) ? format : `${format} ZZZZ`);
